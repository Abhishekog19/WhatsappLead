/**
 * Verification against a real Postgres.
 *
 * Run with: npm run verify --workspace=@wa/db
 *
 * Covers the things TypeScript cannot: the hand-written RLS migration, the
 * `for update skip locked` claim under concurrency, the jsonb contact search,
 * and the raw SQL inside every worker job. Each check asserts an outcome and
 * the script exits non-zero on the first failure, so it is usable in CI.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createDb } from '../client';
import { checkTenantIsolation } from '../isolation';
import { asSystem, withUser } from '../tenant';
import * as schema from '../schema';
import { startPostgres } from './postgres';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  console.log('Starting Postgres…');
  const pg = await startPostgres();

  // Two handles, deliberately. Migrations need the owner; everything the
  // application does runs over the non-superuser connection, because that is
  // the only configuration in which row-level security is actually enforced.
  const owner = createDb({ url: pg.ownerUrl, maxConnections: 2 });
  const app = createDb({ url: pg.appUrl, maxConnections: 6 });
  const db = app.db;

  try {
    // -----------------------------------------------------------------------
    section('Migrations');
    const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
    await migrate(owner.db, { migrationsFolder });
    check('both migrations apply cleanly', true);

    const tables = await owner.db.execute<{ n: number }>(sql`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    // drizzle's own bookkeeping table lives in the `drizzle` schema, not here.
    check('18 tables created', Number(tables[0]?.n) === 18, tables[0]);

    const forced = await owner.db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity
       order by c.relname
    `);
    // 12 tenant tables + users + audit_log.
    check('14 tables have FORCE row level security', forced.length === 14, forced.length);

    const policies = await owner.db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_policies where schemaname = 'public'
    `);
    // Two per tenant table (12 × 2) + users (2) + audit_log (2).
    check('28 policies created', Number(policies[0]?.n) === 28, policies[0]);

    // Idempotency: the deploy may re-run a migration after a failed container.
    await migrate(owner.db, { migrationsFolder });
    check('re-running migrations is a no-op', true);

    // -----------------------------------------------------------------------
    section('Isolation guard');

    // The guard that would have caught the superuser misconfiguration. It has
    // to pass for the app role and fail for the owner, or it is not testing
    // anything.
    const appStatus = await checkTenantIsolation(app.db);
    check('guard passes for the application role', appStatus.ok, appStatus.problems);
    check('application role is not a superuser', !appStatus.isSuperuser);
    check('application role does not have BYPASSRLS', !appStatus.bypassRls);

    const ownerStatus = await checkTenantIsolation(owner.db);
    check(
      'guard rejects a superuser connection',
      !ownerStatus.ok && ownerStatus.isSuperuser,
      ownerStatus.problems,
    );

    // -----------------------------------------------------------------------
    section('Tenant isolation (the product promise)');

    const alice = `u_${randomUUID()}`;
    const bob = `u_${randomUUID()}`;

    // Seeded by the owner: creating users is a bootstrap concern, not
    // something the application does on behalf of a tenant.
    await asSystem(owner.db, async (tx) => {
      await tx.insert(schema.users).values([
        { id: alice, email: 'alice@example.com' },
        { id: bob, email: 'bob@example.com' },
      ]);
      await tx.insert(schema.settings).values([{ userId: alice }, { userId: bob }]);
    });

    // The same lead, held by both users. This is the exact scenario the
    // "one user's data never restricts another's" rule is about.
    const shared = '+919876500001';
    const aliceContact = await withUser(db, alice, async (tx) => {
      const r = await tx
        .insert(schema.contacts)
        .values({ userId: alice, phoneE164: shared, name: "Alice's lead" })
        .returning({ id: schema.contacts.id });
      return r[0]!.id;
    });
    const bobContact = await withUser(db, bob, async (tx) => {
      const r = await tx
        .insert(schema.contacts)
        .values({ userId: bob, phoneE164: shared, name: "Bob's lead" })
        .returning({ id: schema.contacts.id });
      return r[0]!.id;
    });
    check('two users may hold the same phone number', aliceContact !== bobContact);

    const aliceSees = await withUser(db, alice, (tx) =>
      tx.select().from(schema.contacts),
    );
    check(
      'alice sees only her own contact',
      aliceSees.length === 1 && aliceSees[0]?.name === "Alice's lead",
      aliceSees.map((c) => c.name),
    );

    // The important negative: an explicit filter for someone else's id still
    // returns nothing, because the policy is applied on top of the WHERE.
    const crossRead = await withUser(db, alice, (tx) =>
      tx.select().from(schema.contacts).where(sql`user_id = ${bob}`),
    );
    check('alice cannot read bob by asking for his user_id', crossRead.length === 0);

    // Writing into another tenant must fail rather than silently succeed.
    let insertBlocked = false;
    try {
      await withUser(db, alice, (tx) =>
        tx.insert(schema.contacts).values({
          userId: bob,
          phoneE164: '+919876500002',
          name: 'smuggled',
        }),
      );
    } catch {
      insertBlocked = true;
    }
    check('alice cannot insert a row owned by bob', insertBlocked);

    const updateResult = await withUser(db, alice, (tx) =>
      tx
        .update(schema.contacts)
        .set({ name: 'tampered' })
        .where(sql`id = ${bobContact}`)
        .returning({ id: schema.contacts.id }),
    );
    check("alice's update of bob's row affects nothing", updateResult.length === 0);

    const deleteResult = await withUser(db, alice, (tx) =>
      tx
        .delete(schema.contacts)
        .where(sql`id = ${bobContact}`)
        .returning({ id: schema.contacts.id }),
    );
    check("alice's delete of bob's row affects nothing", deleteResult.length === 0);

    const bobIntact = await withUser(db, bob, (tx) =>
      tx.select().from(schema.contacts),
    );
    check(
      "bob's row survived both attempts",
      bobIntact.length === 1 && bobIntact[0]?.name === "Bob's lead",
      bobIntact.map((c) => c.name),
    );

    // -----------------------------------------------------------------------
    section('The escape hatch, and that it is really needed');

    const systemSees = await asSystem(db, (tx) => tx.select().from(schema.contacts));
    check('asSystem sees both tenants', systemSees.length === 2, systemSees.length);

    // If this ever returns rows, FORCE RLS has been dropped and withUser is
    // decorative — the single most dangerous regression in the codebase.
    const unscoped = await app.db.select().from(schema.contacts);
    check(
      'a query with no identity set returns nothing',
      unscoped.length === 0,
      unscoped.length,
    );

    // The pooled-connection hazard: app.user_id must not survive the
    // transaction that set it.
    await withUser(db, alice, async (tx) => {
      await tx.execute(sql`select 1`);
    });
    const afterLeakProbe = await app.db.select().from(schema.contacts);
    check(
      'app.user_id does not leak out of its transaction',
      afterLeakProbe.length === 0,
      afterLeakProbe.length,
    );

    const systemLeak = await asSystem(db, async (tx) => {
      await tx.execute(sql`select 1`);
      return true;
    });
    const afterSystem = await app.db.select().from(schema.contacts);
    check(
      'app.system does not leak either',
      systemLeak && afterSystem.length === 0,
      afterSystem.length,
    );

    // -----------------------------------------------------------------------
    section('Append-only audit log');

    await withUser(db, alice, (tx) =>
      tx.insert(schema.auditLog).values({ userId: alice, action: 'test.event' }),
    );

    let updateRevoked = false;
    try {
      await withUser(db, alice, (tx) =>
        tx.execute(sql`update audit_log set action = 'rewritten'`),
      );
    } catch {
      updateRevoked = true;
    }
    check('audit_log cannot be updated', updateRevoked);

    let deleteRevoked = false;
    try {
      await withUser(db, alice, (tx) => tx.execute(sql`delete from audit_log`));
    } catch {
      deleteRevoked = true;
    }
    check('audit_log cannot be deleted from', deleteRevoked);

    // -----------------------------------------------------------------------
    section('Uniqueness constraints');

    let dupBlocked = false;
    try {
      await withUser(db, alice, (tx) =>
        tx
          .insert(schema.contacts)
          .values({ userId: alice, phoneE164: shared, name: 'duplicate' }),
      );
    } catch {
      dupBlocked = true;
    }
    check('one number appears once per user', dupBlocked);

    const sessionA = await withUser(db, alice, async (tx) => {
      const r = await tx
        .insert(schema.waSessions)
        .values({ userId: alice, phoneE164: '+919000000001', status: 'connected' })
        .returning({ id: schema.waSessions.id });
      return r[0]!.id;
    });

    let sessionDupBlocked = false;
    try {
      await withUser(db, alice, (tx) =>
        tx
          .insert(schema.waSessions)
          .values({ userId: alice, phoneE164: '+919000000001' }),
      );
    } catch {
      sessionDupBlocked = true;
    }
    check('the same number cannot be linked twice', sessionDupBlocked);

    // The index is partial on `deleted_at is null`, so re-linking after an
    // unlink has to work — otherwise a user who unlinks can never come back.
    await withUser(db, alice, (tx) =>
      tx
        .update(schema.waSessions)
        .set({ deletedAt: new Date(), status: 'logged_out' })
        .where(sql`id = ${sessionA}`),
    );
    const relinked = await withUser(db, alice, async (tx) => {
      const r = await tx
        .insert(schema.waSessions)
        .values({ userId: alice, phoneE164: '+919000000001', status: 'connected' })
        .returning({ id: schema.waSessions.id });
      return r[0]!.id;
    });
    check('a number can be re-linked after unlinking', Boolean(relinked));

    // Two users linking the same number is normal — shared office phone.
    const bobSession = await withUser(db, bob, async (tx) => {
      const r = await tx
        .insert(schema.waSessions)
        .values({ userId: bob, phoneE164: '+919000000001', status: 'connected' })
        .returning({ id: schema.waSessions.id });
      return r[0]!.id;
    });
    check('two users may link the same number', Boolean(bobSession));

    // -----------------------------------------------------------------------
    section('Contact search (the jsonb query behind the search box)');

    const listId = await withUser(db, alice, async (tx) => {
      const r = await tx
        .insert(schema.contactLists)
        .values({
          userId: alice,
          name: 'Vadodara clinics',
          columns: ['Name', 'Category', 'Rating', 'Signals'],
        })
        .returning({ id: schema.contactLists.id });
      return r[0]!.id;
    });

    await withUser(db, alice, (tx) =>
      tx.insert(schema.contacts).values([
        {
          userId: alice,
          listId,
          phoneE164: '+917201864189',
          name: 'Ishwar Dental Clinic',
          fields: { Category: 'Dental clinic', Rating: '4.9', Signals: 'No Website' },
        },
        {
          userId: alice,
          listId,
          phoneE164: '+917984548806',
          name: 'Sankalp Skin Care',
          fields: { Category: 'Skin care clinic', Rating: '5', Signals: 'No Website' },
        },
      ]),
    );

    const searchQuery = async (query: string): Promise<string[]> => {
      const digits = query.replace(/\D/g, '');
      const term = `%${query.toLowerCase()}%`;
      return withUser(db, alice, async (tx) => {
        const rows = await tx.execute<{ name: string }>(sql`
          select name from contacts
           where user_id = ${alice}
             and (
               name ilike ${term}
               or (${digits} <> '' and regexp_replace(phone_e164, '\\D', '', 'g') like ${'%' + digits + '%'})
               or exists (
                 select 1 from jsonb_each_text(fields) as f(k, v)
                  where lower(f.v) like ${term}
               )
             )
        `);
        return rows.map((r) => r.name);
      });
    };

    check('finds by name fragment', (await searchQuery('dental')).length === 1);
    check(
      'finds by a spreadsheet field value',
      (await searchQuery('skin care')).length === 1,
    );
    check(
      'finds by field shared across rows',
      (await searchQuery('no website')).length === 2,
    );
    // The three formats a user might paste from WhatsApp, a sheet, or a form.
    check('finds by full E.164', (await searchQuery('+917201864189')).length === 1);
    check('finds by spaced number', (await searchQuery('+91 72018 64189')).length === 1);
    check('finds by local digits only', (await searchQuery('7201864189')).length === 1);
    check('no match returns nothing', (await searchQuery('zzzznope')).length === 0);

    // -----------------------------------------------------------------------
    section('Contacts upsert (re-uploading a spreadsheet)');

    const upsert = async (name: string, fields: Record<string, string>) =>
      withUser(db, alice, async (tx) =>
        tx
          .insert(schema.contacts)
          .values({ userId: alice, listId, phoneE164: '+917201864189', name, fields })
          .onConflictDoUpdate({
            target: [schema.contacts.userId, schema.contacts.phoneE164],
            set: {
              name: sql`coalesce(excluded.name, ${schema.contacts.name})`,
              fields: sql`excluded.fields`,
              listId: sql`excluded.list_id`,
              updatedAt: new Date(),
            },
          })
          .returning({
            isNew: sql<boolean>`${schema.contacts.createdAt} = ${schema.contacts.updatedAt}`,
            name: schema.contacts.name,
            messageCount: schema.contacts.messageCount,
          }),
      );

    // Pretend the contact has already been messaged, which is the history that
    // must survive a re-upload — it is what prevents a duplicate message.
    await withUser(db, alice, (tx) =>
      tx
        .update(schema.contacts)
        .set({ lastMessagedAt: new Date(), messageCount: 1 })
        .where(sql`phone_e164 = '+917201864189'`),
    );

    const reupload = await upsert('Ishwar Dental Clinic & Implant Centre', {
      Category: 'Dental clinic',
      Rating: '4.8',
    });
    check(
      're-upload is detected as an update, not an insert',
      reupload[0]?.isNew === false,
      reupload[0],
    );
    check(
      're-upload takes the newer name',
      reupload[0]?.name === 'Ishwar Dental Clinic & Implant Centre',
    );
    check(
      're-upload preserves the send history',
      reupload[0]?.messageCount === 1,
      reupload[0],
    );

    const freshInsert = await withUser(db, alice, async (tx) =>
      tx
        .insert(schema.contacts)
        .values({ userId: alice, listId, phoneE164: '+917000000099', name: 'Brand new' })
        .onConflictDoUpdate({
          target: [schema.contacts.userId, schema.contacts.phoneE164],
          set: { name: sql`excluded.name`, updatedAt: new Date() },
        })
        .returning({
          isNew: sql<boolean>`${schema.contacts.createdAt} = ${schema.contacts.updatedAt}`,
        }),
    );
    check('a genuinely new row is detected as an insert', freshInsert[0]?.isNew === true);

    // -----------------------------------------------------------------------
    section('Campaign setup and the claim query');

    const templateId = await withUser(db, alice, async (tx) => {
      const t = await tx
        .insert(schema.templates)
        .values({ userId: alice, name: 'Website offer' })
        .returning({ id: schema.templates.id });
      const id = t[0]!.id;
      await tx.insert(schema.templateVariants).values([
        { templateId: id, userId: alice, body: 'Hi {{name}}, option A', position: 0 },
        { templateId: id, userId: alice, body: 'Hello {{name}}, option B', position: 1 },
      ]);
      return id;
    });

    const campaignId = await withUser(db, alice, async (tx) => {
      const c = await tx
        .insert(schema.campaigns)
        .values({
          userId: alice,
          name: 'Clinics',
          sessionId: relinked,
          listId,
          templateId,
          status: 'running',
        })
        .returning({ id: schema.campaigns.id });
      return c[0]!.id;
    });

    const materialised = await withUser(db, alice, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        with inserted as (
          insert into campaign_targets (campaign_id, user_id, contact_id)
          select ${campaignId}, ${alice}, c.id
            from contacts c
           where c.user_id = ${alice} and c.list_id = ${listId}
          on conflict (campaign_id, contact_id) do nothing
          returning 1
        )
        select count(*)::int as n from inserted
      `);
      return Number(rows[0]?.n ?? 0);
    });
    check('targets are materialised in one statement', materialised === 3, materialised);

    // Re-running must add nothing: the ON CONFLICT is what stops a second
    // "create" from queueing everyone twice.
    const again = await withUser(db, alice, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        with inserted as (
          insert into campaign_targets (campaign_id, user_id, contact_id)
          select ${campaignId}, ${alice}, c.id
            from contacts c
           where c.user_id = ${alice} and c.list_id = ${listId}
          on conflict (campaign_id, contact_id) do nothing
          returning 1
        )
        select count(*)::int as n from inserted
      `);
      return Number(rows[0]?.n ?? 0);
    });
    check('re-materialising adds no duplicates', again === 0, again);

    const claimOne = async (): Promise<string | null> =>
      asSystem(db, async (tx) => {
        const rows = await tx.execute<{ target_id: string }>(sql`
          with claimed as (
            select t.id from campaign_targets t
             where t.campaign_id = ${campaignId} and t.status = 'pending'
             order by t.created_at
             for update skip locked
             limit 1
          )
          update campaign_targets t
             set status = 'sending', claimed_at = now()
            from claimed c, contacts ct
           where t.id = c.id and ct.id = t.contact_id
          returning t.id as target_id
        `);
        return rows[0]?.target_id ?? null;
      });

    const first = await claimOne();
    const second = await claimOne();
    check('claims return distinct targets', Boolean(first && second && first !== second), {
      first,
      second,
    });

    // The real test of SKIP LOCKED: simultaneous claimers, no overlap, no
    // blocking. This is what makes running two workers safe.
    const concurrent = await Promise.all([claimOne(), claimOne(), claimOne()]);
    const got = concurrent.filter(Boolean);
    check(
      'concurrent claims never collide',
      new Set(got).size === got.length,
      concurrent,
    );
    check('claims stop when the queue is empty', got.length === 1, got.length);

    // -----------------------------------------------------------------------
    section('Rolling 24-hour budget');

    await asSystem(db, (tx) =>
      tx.insert(schema.newContactSends).values([
        {
          userId: alice,
          sessionId: relinked,
          phoneE164: '+917201864189',
          sentAt: new Date(Date.now() - 2 * 3_600_000),
        },
        {
          userId: alice,
          sessionId: relinked,
          phoneE164: '+917984548806',
          sentAt: new Date(Date.now() - 23 * 3_600_000),
        },
        // Just outside the window: proves it rolls rather than resetting.
        {
          userId: alice,
          sessionId: relinked,
          phoneE164: '+917000000099',
          sentAt: new Date(Date.now() - 25 * 3_600_000),
        },
      ]),
    );

    const used = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from new_contact_sends
         where session_id = ${relinked} and sent_at > now() - interval '24 hours'
      `);
      return Number(rows[0]?.n ?? 0);
    });
    check('the 24h window excludes older sends', used === 2, used);

    const bobUsed = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from new_contact_sends
         where session_id = ${bobSession} and sent_at > now() - interval '24 hours'
      `);
      return Number(rows[0]?.n ?? 0);
    });
    check("alice's sending does not consume bob's budget", bobUsed === 0, bobUsed);

    // -----------------------------------------------------------------------
    section('Worker jobs');

    // reap-stale-claims: a row with a message id was really sent, so it must
    // settle as sent rather than being retried into a duplicate.
    await asSystem(db, (tx) =>
      tx.execute(sql`
        update campaign_targets
           set status = 'sending',
               claimed_at = now() - interval '20 minutes',
               wa_message_id = 'ABC123',
               sent_at = now() - interval '20 minutes'
         where id = ${first}
      `),
    );
    const settled = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        update campaign_targets
           set status = 'sent', claimed_at = null
         where status = 'sending'
           and claimed_at < now() - interval '10 minutes'
           and (wa_message_id is not null or sent_at is not null)
        returning id
      `);
      return rows.map((r) => r.id);
    });
    check('reaper settles an already-sent claim as sent', settled.includes(first!), settled);

    await asSystem(db, (tx) =>
      tx.execute(sql`
        update campaign_targets
           set status = 'sending', claimed_at = now() - interval '20 minutes',
               wa_message_id = null, sent_at = null, attempts = 0
         where id = ${second}
      `),
    );
    const released = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ id: string; attempts: number }>(sql`
        update campaign_targets
           set status = 'pending', claimed_at = null, attempts = attempts + 1,
               last_error = 'worker stopped mid-send; claim released'
         where status = 'sending'
           and claimed_at < now() - interval '10 minutes'
           and wa_message_id is null and sent_at is null
           and attempts < 3
        returning id, attempts
      `);
      return rows;
    });
    check(
      'reaper releases an orphaned claim for retry',
      released.some((r) => r.id === second && Number(r.attempts) === 1),
      released,
    );

    // settle-campaigns: counters are recomputed, not incremented, so no code
    // path has to remember to bump a number.
    await asSystem(db, (tx) =>
      tx.execute(sql`
        update campaign_targets set status = 'sent' where campaign_id = ${campaignId}
      `),
    );
    await asSystem(db, (tx) =>
      tx.execute(sql`
        with totals as (
          select campaign_id,
                 count(*) filter (where status = 'sent')::int    as sent,
                 count(*) filter (where status = 'failed')::int   as failed,
                 count(*) filter (where status = 'skipped')::int  as skipped
            from campaign_targets group by campaign_id
        )
        update campaigns c
           set sent_count = t.sent, failed_count = t.failed, skipped_count = t.skipped,
               updated_at = now()
          from totals t
         where c.id = t.campaign_id
           and c.status in ('running','paused','scheduled')
           and (c.sent_count, c.failed_count, c.skipped_count)
               is distinct from (t.sent, t.failed, t.skipped)
      `),
    );
    const counters = await withUser(db, alice, async (tx) => {
      const rows = await tx
        .select({
          sent: schema.campaigns.sentCount,
          status: schema.campaigns.status,
        })
        .from(schema.campaigns)
        .where(sql`id = ${campaignId}`);
      return rows[0];
    });
    check('campaign counters are recomputed correctly', counters?.sent === 3, counters);

    await asSystem(db, (tx) =>
      tx.execute(sql`
        update campaigns c
           set status = 'completed', completed_at = now()
         where c.status = 'running'
           and not exists (
             select 1 from campaign_targets t
              where t.campaign_id = c.id and t.status in ('pending','sending')
           )
      `),
    );
    const completed = await withUser(db, alice, async (tx) => {
      const rows = await tx
        .select({ status: schema.campaigns.status })
        .from(schema.campaigns)
        .where(sql`id = ${campaignId}`);
      return rows[0]?.status;
    });
    check('a drained campaign is marked completed', completed === 'completed', completed);

    // expire-pairing-artifacts: a live pairing code is equivalent to device
    // access, so an expired one must actually disappear.
    const pairingSession = await withUser(db, alice, async (tx) => {
      const r = await tx
        .insert(schema.waSessions)
        .values({
          userId: alice,
          phoneE164: '+919000000055',
          status: 'pairing',
          pairingCode: 'ABCD-1234',
          pairingCodeExpiresAt: new Date(Date.now() - 60_000),
        })
        .returning({ id: schema.waSessions.id });
      return r[0]!.id;
    });

    await asSystem(db, (tx) =>
      tx.execute(sql`
        update wa_sessions
           set pairing_code = case when pairing_code_expires_at < now() then null else pairing_code end,
               pairing_code_expires_at = case when pairing_code_expires_at < now() then null else pairing_code_expires_at end,
               qr_payload = case when qr_expires_at < now() then null else qr_payload end,
               qr_expires_at = case when qr_expires_at < now() then null else qr_expires_at end
         where (pairing_code_expires_at < now() and pairing_code is not null)
            or (qr_expires_at < now() and qr_payload is not null)
      `),
    );
    const expired = await withUser(db, alice, async (tx) => {
      const rows = await tx
        .select({ code: schema.waSessions.pairingCode })
        .from(schema.waSessions)
        .where(sql`id = ${pairingSession}`);
      return rows[0];
    });
    check('an expired pairing code is cleared', expired?.code === null, expired);

    // -----------------------------------------------------------------------
    section('Suppression beats dedupe configuration');

    await withUser(db, alice, (tx) =>
      tx.insert(schema.suppressions).values({
        userId: alice,
        phoneE164: '+917201864189',
        reason: 'opt_out',
      }),
    );

    // Second identical "stop" reply: must not error.
    const idempotent = await withUser(db, alice, async (tx) => {
      await tx
        .insert(schema.suppressions)
        .values({ userId: alice, phoneE164: '+917201864189', reason: 'opt_out' })
        .onConflictDoNothing();
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.suppressions)
        .where(sql`user_id = ${alice}`);
      return Number(rows[0]?.n ?? 0);
    });
    check('suppressing twice is idempotent', idempotent === 1, idempotent);

    const bobUnaffected = await withUser(db, bob, async (tx) => {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.suppressions);
      return Number(rows[0]?.n ?? 0);
    });
    check(
      "alice's suppression does not block bob from that number",
      bobUnaffected === 0,
      bobUnaffected,
    );

    // -----------------------------------------------------------------------
    section('Cascades');

    await asSystem(owner.db, (tx) => tx.delete(schema.users).where(sql`id = ${bob}`));
    const orphans = await asSystem(db, async (tx) => {
      const rows = await tx.execute<{ contacts: number; sessions: number }>(sql`
        select
          (select count(*)::int from contacts     where user_id = ${bob}) as contacts,
          (select count(*)::int from wa_sessions  where user_id = ${bob}) as sessions
      `);
      return rows[0];
    });
    check(
      'deleting a user removes their data',
      Number(orphans?.contacts) === 0 && Number(orphans?.sessions) === 0,
      orphans,
    );

    const aliceSurvives = await withUser(db, alice, async (tx) => {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.contacts);
      return Number(rows[0]?.n ?? 0);
    });
    // Four: the shared lead, the two clinics, and the upsert probe.
    check("deleting bob left alice's data alone", aliceSurvives === 4, aliceSurvives);
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
