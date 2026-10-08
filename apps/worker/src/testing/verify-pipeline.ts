/**
 * End-to-end verification of the send pipeline.
 *
 * Run with: npm run verify:pipeline --workspace=@wa/worker
 *
 * Everything is real except the WhatsApp socket: a real Postgres, the real
 * migrations, the real import mapping, the real template rendering, and the
 * real send job. The socket is stubbed because the alternative is messaging
 * actual people from a test.
 *
 * This is the check that the pieces fit together — typechecking proves the
 * shapes line up, not that a campaign actually drains, that dedupe skips the
 * right rows, or that the daily cap stops anything.
 */

import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql } from 'drizzle-orm';
import { createDb, asSystem, schema, type Database } from '@wa/db';
import { MIGRATIONS_FOLDER, startPostgres } from '@wa/db/testing';
import { createLogger, mapRows } from '@wa/core';
import { detectOptOut } from '@wa/wa';
import { sendCampaigns } from '../jobs/send-campaigns';
import type { WorkerContext } from '../context';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(
      `  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** Records what would have gone to WhatsApp. */
interface SentMessage {
  phoneE164: string;
  text: string;
  typingMs: number;
}

function stubManager(options: {
  sent: SentMessage[];
  connected: boolean;
  notOnWhatsApp?: Set<string>;
  failWith?: () => Error;
}) {
  const connection = {
    get isConnected() {
      return options.connected;
    },
    async sendText(phoneE164: string, text: string, o: { typingMs?: number } = {}) {
      if (options.failWith) throw options.failWith();
      options.sent.push({ phoneE164, text, typingMs: o.typingMs ?? 0 });
      return { waMessageId: `wamid.${randomUUID()}`, sentAt: new Date() };
    },
    async checkOnWhatsApp(numbers: readonly string[]) {
      const out = new Map<string, boolean>();
      for (const n of numbers) out.set(n, !options.notOnWhatsApp?.has(n));
      return out;
    },
  };

  return {
    get: () => connection,
    has: () => true,
    size: 1,
    statuses: () => ({}),
  };
}

async function main(): Promise<void> {
  console.log('Starting Postgres…');
  const pg = await startPostgres();
  const owner = createDb({ url: pg.ownerUrl, maxConnections: 2 });
  const app = createDb({ url: pg.appUrl, maxConnections: 6 });

  await migrate(owner.db, { migrationsFolder: MIGRATIONS_FOLDER });

  const db: Database = app.db;
  // Quiet: the job logs every send, and that would bury the check output.
  const log = createLogger({ level: 'error', base: { service: 'verify' } });

  try {
    // -----------------------------------------------------------------------
    section('Seeding a realistic account');

    const userId = `u_${randomUUID()}`;
    await asSystem(owner.db, async (tx) => {
      await tx.insert(schema.users).values({ id: userId, email: 'test@example.com' });
      await tx.insert(schema.settings).values({
        userId,
        // Fast enough for a test, still above the floors in @wa/core/pacing.
        minDelayMs: 1_000,
        maxDelayMs: 1_500,
        simulateTyping: false,
        // Wide open, so the window is never the reason nothing sends.
        sendWindowStartHour: 0,
        sendWindowEndHour: 24,
        skipWeekends: false,
      });
    });

    const sessionId = await asSystem(db, async (tx) => {
      const r = await tx
        .insert(schema.waSessions)
        .values({
          userId,
          phoneE164: '+919000000001',
          status: 'connected',
          accountType: 'personal',
          credsEncrypted: 'stub',
          // Day 8+, so the warm-up ramp is over and the tier cap applies.
          linkedAt: new Date(Date.now() - 30 * 86_400_000),
          tier: 1,
        })
        .returning({ id: schema.waSessions.id });
      return r[0]!.id;
    });

    // The real spreadsheet's shape, through the real mapping code.
    const rawRows = [
      { Name: 'Ishwar Dental Clinic', Phone: '+91 72018 64189', Category: 'Dental clinic', Rating: '4.9', Reviews: '33', Signals: 'No Website', Website: '-' },
      { Name: 'Sankalp Skin Care', Phone: '+91 79845 48806', Category: 'Skin care clinic', Rating: '5', Reviews: '72', Signals: 'No Website', Website: '-' },
      { Name: 'Vadodara Physio', Phone: '+91 98250 11111', Category: 'Physical therapy clinic', Rating: '4.5', Reviews: '12', Signals: 'No Website; Few Reviews', Website: '-' },
      { Name: 'Already Messaged Clinic', Phone: '+91 98250 22222', Category: 'Dentist', Rating: '4.2', Reviews: '8', Signals: 'No Website', Website: '-' },
      { Name: 'Opted Out Clinic', Phone: '+91 98250 33333', Category: 'Doctor', Rating: '4.0', Reviews: '5', Signals: 'No Website', Website: '-' },
      { Name: 'Landline Only', Phone: '+91 98250 44444', Category: 'Hospital', Rating: '3.9', Reviews: '2', Signals: 'No Website', Website: '-' },
      { Name: 'No Phone Clinic', Phone: '-', Category: 'Clinic', Rating: '4.1', Reviews: '3', Signals: 'No Website; No Phone', Website: '-' },
    ];

    const mapped = mapRows(rawRows, { phone: 'Phone', name: 'Name' }, { defaultCountry: 'IN' });
    check('import rejects the row with no phone', mapped.rejected.length === 1, mapped.rejected);
    check('import maps the remaining six', mapped.rows.length === 6, mapped.rows.length);

    const listId = await asSystem(db, async (tx) => {
      const r = await tx
        .insert(schema.contactLists)
        .values({
          userId,
          name: 'Vadodara clinics',
          columns: mapped.columns,
          rowsTotal: mapped.totalRows,
          rowsImported: mapped.rows.length,
        })
        .returning({ id: schema.contactLists.id });
      return r[0]!.id;
    });

    await asSystem(db, (tx) =>
      tx.insert(schema.contacts).values(
        mapped.rows.map((r) => ({
          userId,
          listId,
          phoneE164: r.phoneE164,
          name: r.name,
          fields: r.fields,
        })),
      ),
    );

    // One contact already messaged — dedupe must skip it.
    await asSystem(db, (tx) =>
      tx
        .update(schema.contacts)
        .set({ lastMessagedAt: new Date(Date.now() - 86_400_000), messageCount: 1 })
        .where(eq(schema.contacts.phoneE164, '+919825022222')),
    );

    // One opted out — suppression must skip it regardless of dedupe mode.
    await asSystem(db, (tx) =>
      tx.insert(schema.suppressions).values({
        userId,
        phoneE164: '+919825033333',
        reason: 'opt_out',
      }),
    );

    const templateId = await asSystem(db, async (tx) => {
      const t = await tx
        .insert(schema.templates)
        .values({ userId, name: 'Website offer' })
        .returning({ id: schema.templates.id });
      const id = t[0]!.id;
      await tx.insert(schema.templateVariants).values([
        {
          templateId: id,
          userId,
          label: 'A',
          body: 'Hi {{Name}}, {saw|came across} your {{Category}} — {{Rating}} stars from {{Reviews}} reviews. Noticed: {{Signals}}. Built you a sample homepage, want to see it?',
          position: 0,
        },
        {
          templateId: id,
          userId,
          label: 'B',
          body: 'Hello {{Name}}! Your {{Category}} has {{Reviews}} reviews but no website. I made a mock-up — interested?',
          position: 1,
        },
      ]);
      return id;
    });

    const campaignId = await asSystem(db, async (tx) => {
      const c = await tx
        .insert(schema.campaigns)
        .values({
          userId,
          name: 'Clinics outreach',
          sessionId,
          listId,
          templateId,
          status: 'running',
          startedAt: new Date(),
        })
        .returning({ id: schema.campaigns.id });
      const id = c[0]!.id;
      const inserted = await tx.execute<{ n: number }>(sql`
        with inserted as (
          insert into campaign_targets (campaign_id, user_id, contact_id)
          select ${id}, ${userId}, c.id from contacts c
           where c.user_id = ${userId} and c.list_id = ${listId}
          returning 1
        ) select count(*)::int as n from inserted
      `);
      await tx
        .update(schema.campaigns)
        .set({ totalTargets: Number(inserted[0]?.n ?? 0) })
        .where(eq(schema.campaigns.id, id));
      return id;
    });

    // -----------------------------------------------------------------------
    section('Draining a campaign');

    const sent: SentMessage[] = [];
    const wa = stubManager({
      sent,
      connected: true,
      // A landline: WhatsApp says not registered, so it must be skipped.
      notOnWhatsApp: new Set(['+919825044444']),
    });

    const ctx = {
      env: {
        PLATFORM_MAX_NEW_CONTACTS_24H: 120,
        LOG_LEVEL: 'error',
      },
      log,
      db,
      sql: app.sql,
      wa,
      workerId: 'verify',
    } as unknown as WorkerContext;

    const controller = new AbortController();
    const totals = { sent: 0, skipped: 0, failed: 0, held: 0 };

    // The job sends at most one message per campaign per tick by design, and
    // waits out its own pacing delay in between. Looping here is what a few
    // minutes of real scheduler ticks would do.
    const deadline = Date.now() + 60_000;
    for (let i = 0; i < 200 && Date.now() < deadline; i++) {
      const r = (await sendCampaigns.run(ctx, controller.signal)) as
        | typeof totals
        | undefined;
      if (r) {
        totals.sent += r.sent;
        totals.skipped += r.skipped;
        totals.failed += r.failed;
        totals.held += r.held;
      }
      const remaining = await asSystem(db, async (tx) => {
        const rows = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from campaign_targets
           where campaign_id = ${campaignId} and status in ('pending','sending')
        `);
        return Number(rows[0]?.n ?? 0);
      });
      if (remaining === 0) break;
      await new Promise((r2) => setTimeout(r2, 250));
    }

    check('three sendable contacts were messaged', sent.length === 3, {
      sent: sent.length,
      to: sent.map((s) => s.phoneE164),
    });

    const states = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{
        phone_e164: string;
        status: string;
        skip_reason: string | null;
      }>(sql`
        select ct.phone_e164, t.status, t.skip_reason
          from campaign_targets t
          join contacts ct on ct.id = t.contact_id
         where t.campaign_id = ${campaignId}
         order by ct.phone_e164
      `);
      return rows;
    });

    const byPhone = new Map(states.map((s) => [s.phone_e164, s]));

    check(
      'the already-messaged contact was skipped as a duplicate',
      byPhone.get('+919825022222')?.skip_reason === 'duplicate',
      byPhone.get('+919825022222'),
    );
    check(
      'the opted-out contact was skipped as suppressed',
      byPhone.get('+919825033333')?.skip_reason === 'suppressed',
      byPhone.get('+919825033333'),
    );
    check(
      'the landline was skipped as not on WhatsApp',
      byPhone.get('+919825044444')?.skip_reason === 'not_on_whatsapp',
      byPhone.get('+919825044444'),
    );
    check(
      'nothing is left pending',
      states.every((s) => s.status !== 'pending' && s.status !== 'sending'),
      states.filter((s) => s.status === 'pending' || s.status === 'sending'),
    );

    // -----------------------------------------------------------------------
    section('What was actually sent');

    const first = sent.find((s) => s.phoneE164 === '+917201864189');
    check('placeholders were substituted', Boolean(first && !first.text.includes('{{')), first?.text);
    check(
      'spreadsheet columns reached the message',
      Boolean(first?.text.includes('Dental clinic') && first?.text.includes('4.9')),
      first?.text,
    );
    check(
      'spintax was expanded to one option',
      Boolean(first && !first.text.includes('|') && !first.text.includes('{')),
      first?.text,
    );
    if (first) console.log(`       "${first.text}"`);

    const bodies = new Set(sent.map((s) => s.text.slice(0, 20)));
    check('variants were rotated across recipients', bodies.size > 1, [...bodies]);

    const persisted = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ rendered_body: string; wa_message_id: string }>(sql`
        select rendered_body, wa_message_id from campaign_targets
         where campaign_id = ${campaignId} and status = 'sent'
      `);
      return rows;
    });
    check(
      'the exact text sent was stored for the transcript',
      persisted.length === 3 && persisted.every((p) => p.rendered_body?.length > 20),
      persisted.length,
    );
    check(
      "WhatsApp's message id was recorded for receipts",
      persisted.every((p) => p.wa_message_id?.startsWith('wamid.')),
    );

    // -----------------------------------------------------------------------
    section('Ledgers and counters');

    const ledger = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from new_contact_sends
         where session_id = ${sessionId} and sent_at > now() - interval '24 hours'
      `);
      return Number(rows[0]?.n ?? 0);
    });
    check('each new contact consumed exactly one unit of quota', ledger === 3, ledger);

    const events = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from message_events
         where campaign_id = ${campaignId} and direction = 'out' and type = 'sent'
      `);
      return Number(rows[0]?.n ?? 0);
    });
    check('one outbound event per send', events === 3, events);

    const contactState = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from contacts
         where user_id = ${userId} and last_messaged_at is not null
      `);
      return Number(rows[0]?.n ?? 0);
    });
    // The three just sent, plus the one that was already marked.
    check('contacts record their last message', contactState === 4, contactState);

    const variantCounts = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select coalesce(sum(sent_count), 0)::int as n from template_variants
         where template_id = ${templateId}
      `);
      return Number(rows[0]?.n ?? 0);
    });
    check('per-variant send counts add up', variantCounts === 3, variantCounts);

    // -----------------------------------------------------------------------
    section('The daily cap actually stops sending');

    // Tier-1 personal allows 30 new contacts per rolling day, and three are
    // already spent, so 27 more fills it exactly.
    await asSystem(db, (tx) =>
      tx.insert(schema.newContactSends).values(
        Array.from({ length: 27 }, (_, i) => ({
          userId,
          sessionId,
          phoneE164: `+9199999${String(i).padStart(5, '0')}`,
          sentAt: new Date(Date.now() - 3_600_000),
        })),
      ),
    );

    const capList = await asSystem(db, async (tx) => {
      const r = await tx
        .insert(schema.contactLists)
        .values({ userId, name: 'Overflow', columns: [] })
        .returning({ id: schema.contactLists.id });
      const id = r[0]!.id;
      await tx.insert(schema.contacts).values([
        { userId, listId: id, phoneE164: '+919111100001', name: 'Over 1' },
        { userId, listId: id, phoneE164: '+919111100002', name: 'Over 2' },
      ]);
      return id;
    });

    const cappedCampaign = await asSystem(db, async (tx) => {
      const c = await tx
        .insert(schema.campaigns)
        .values({
          userId,
          name: 'Over cap',
          sessionId,
          listId: capList,
          templateId,
          status: 'running',
          startedAt: new Date(),
          totalTargets: 2,
        })
        .returning({ id: schema.campaigns.id });
      const id = c[0]!.id;
      await tx.execute(sql`
        insert into campaign_targets (campaign_id, user_id, contact_id)
        select ${id}, ${userId}, c.id from contacts c
         where c.user_id = ${userId} and c.list_id = ${capList}
      `);
      return id;
    });

    // Drive the job until either it sends or the pacer has long since come
    // due. A bare "nothing was sent" would otherwise prove only that the
    // inter-message delay had not elapsed yet.
    const drive = async (ms: number): Promise<void> => {
      const until = Date.now() + ms;
      const mark = sent.length;
      while (Date.now() < until) {
        await sendCampaigns.run(ctx, controller.signal);
        if (sent.length > mark) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    const before = sent.length;
    await drive(14_000);
    check(
      'nothing is sent once the rolling cap is reached',
      sent.length === before,
      { before, after: sent.length },
    );

    const stillPending = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from campaign_targets
         where campaign_id = ${cappedCampaign} and status = 'pending'
      `);
      return Number(rows[0]?.n ?? 0);
    });
    check(
      'capped targets stay queued rather than failing',
      stillPending === 2,
      stillPending,
    );

    // The differential that makes the above meaningful: raise the earned tier
    // so the cap goes from 30 to 60, and the identical setup now sends. If it
    // still did not, the pause was never about the budget.
    await asSystem(db, (tx) =>
      tx
        .update(schema.waSessions)
        .set({ tier: 4 })
        .where(eq(schema.waSessions.id, sessionId)),
    );

    // A fresh campaign, because the capped one's pacer was deliberately
    // pushed ten minutes out when it ran out of budget.
    await asSystem(db, async (tx) => {
      const r = await tx
        .insert(schema.contactLists)
        .values({ userId, name: 'After raise', columns: [] })
        .returning({ id: schema.contactLists.id });
      const id = r[0]!.id;
      await tx
        .insert(schema.contacts)
        .values({ userId, listId: id, phoneE164: '+919111100003', name: 'After raise' });
      const c = await tx
        .insert(schema.campaigns)
        .values({
          userId,
          name: 'After raise',
          sessionId,
          listId: id,
          templateId,
          status: 'running',
          startedAt: new Date(),
          totalTargets: 1,
        })
        .returning({ id: schema.campaigns.id });
      await tx.execute(sql`
        insert into campaign_targets (campaign_id, user_id, contact_id)
        select ${c[0]!.id}, ${userId}, ct.id from contacts ct
         where ct.user_id = ${userId} and ct.list_id = ${id}
      `);
    });

    const beforeRaise = sent.length;
    await drive(20_000);
    check(
      'raising the tier lets sending resume, proving the cap was the blocker',
      sent.length > beforeRaise,
      { beforeRaise, after: sent.length },
    );

    // -----------------------------------------------------------------------
    section('Opt-out wording');

    const cases: [string, boolean][] = [
      ['STOP', true],
      ['stop', true],
      ['Please remove me from your list', true],
      ['unsubscribe', true],
      ['Not interested', true],
      ['no thanks', true],
      ['Yes! Please send it over', false],
      ['Can you stop by the clinic on Monday to show me?', false],
      ['No website yet, send the mock-up', false],
      ['Sounds interesting, what is the price?', false],
    ];
    for (const [text, expected] of cases) {
      check(
        `opt-out ${expected ? 'detected' : 'not triggered'}: "${text}"`,
        detectOptOut(text) === expected,
      );
    }
  } finally {
    await app.sql.end({ timeout: 5 }).catch(() => undefined);
    await owner.sql.end({ timeout: 5 }).catch(() => undefined);
    await pg.stop();
  }

  console.log(
    `\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nVerification crashed:', err);
  process.exit(1);
});
