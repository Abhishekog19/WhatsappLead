import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Logger, ThrottleSignal } from '@wa/core';
import { THROTTLE_RESPONSE, maskPhone } from '@wa/core';
import { asSystem, schema, type Database } from '@wa/db';
import { WaConnection, type WaStatus } from './connection';
import { detectOptOut } from './opt-out';

/**
 * Owns every live WhatsApp socket in this process.
 *
 * One instance per worker. All the database writes that an engine event
 * implies — status changes, throttle responses, reply bookkeeping — happen
 * here rather than in {@link WaConnection}, so the connection stays a pure
 * protocol wrapper and this stays the one place that knows what an event
 * means to the product.
 */
export class WaManager {
  private readonly connections = new Map<string, WaConnection>();

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: string,
    private readonly log: Logger,
    private readonly logLevel: string = 'silent',
  ) {}

  get size(): number {
    return this.connections.size;
  }

  has(sessionId: string): boolean {
    return this.connections.has(sessionId);
  }

  get(sessionId: string): WaConnection | undefined {
    return this.connections.get(sessionId);
  }

  /** Every session this process currently holds a socket for. */
  statuses(): Record<string, WaStatus> {
    const out: Record<string, WaStatus> = {};
    for (const [id, conn] of this.connections) out[id] = conn.status;
    return out;
  }

  /**
   * Opens a socket for an already-linked session, reusing one if present.
   *
   * Returns null when the session has no stored credentials — that case needs
   * {@link startLinking} and a human with a phone, not a silent retry.
   */
  async resume(session: {
    id: string;
    userId: string;
    credsEncrypted: string | null;
  }): Promise<WaConnection | null> {
    const existing = this.connections.get(session.id);
    if (existing) return existing;
    if (!session.credsEncrypted) return null;

    const conn = this.build(session.id, session.userId);
    this.connections.set(session.id, conn);
    await conn.open();
    return conn;
  }

  /**
   * Starts the pairing-code handshake for a number the user just added.
   *
   * The code lands in `wa_sessions.pairing_code`, which is what the browser
   * polls — the web tier never talks to this process directly.
   */
  async startLinking(session: {
    id: string;
    userId: string;
    phoneE164: string;
  }): Promise<WaConnection> {
    // A half-open socket from a previous attempt would race the new one for
    // the same registration, so replace rather than reuse.
    await this.drop(session.id);

    const conn = this.build(session.id, session.userId);
    this.connections.set(session.id, conn);
    await conn.open(session.phoneE164);
    return conn;
  }

  /** Unlinks from the user's phone and forgets the credentials. */
  async unlink(sessionId: string): Promise<void> {
    const conn = this.connections.get(sessionId);
    if (conn) {
      await conn.logout();
      this.connections.delete(sessionId);
      return;
    }
    // No live socket: still clear the stored credentials so the row cannot be
    // resumed later.
    await asSystem(this.db, async (tx) => {
      await tx
        .update(schema.waSessions)
        .set({
          credsEncrypted: null,
          status: 'logged_out',
          pairingCode: null,
          pairingCodeExpiresAt: null,
          qrPayload: null,
          qrExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.waSessions.id, sessionId));
    });
  }

  /** Closes a socket without unlinking. */
  async drop(sessionId: string): Promise<void> {
    const conn = this.connections.get(sessionId);
    if (!conn) return;
    this.connections.delete(sessionId);
    await conn.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.connections.values()];
    this.connections.clear();
    // Sequential, not Promise.all: each close flushes an encrypted credential
    // write, and a stampede of those on shutdown is how auth state gets
    // corrupted.
    for (const conn of all) {
      await conn.close().catch((err) =>
        this.log.error('failed to close connection cleanly', { error: err }),
      );
    }
  }

  // -------------------------------------------------------------------------

  private build(sessionId: string, userId: string): WaConnection {
    const log = this.log.child({ sessionId });

    return new WaConnection({
      db: this.db,
      sessionId,
      userId,
      encryptionKey: this.encryptionKey,
      log,
      logLevel: this.logLevel,
      handlers: {
        onStatus: (status, detail) => this.persistStatus(sessionId, status, detail),

        onPairingCode: async (code, expiresAt) => {
          await asSystem(this.db, async (tx) => {
            await tx
              .update(schema.waSessions)
              .set({
                status: 'pairing',
                pairingCode: code,
                pairingCodeExpiresAt: expiresAt,
                qrPayload: null,
                qrExpiresAt: null,
                lastError: null,
                updatedAt: new Date(),
              })
              .where(eq(schema.waSessions.id, sessionId));
          });
        },

        onQr: async (payload, expiresAt) => {
          await asSystem(this.db, async (tx) => {
            await tx
              .update(schema.waSessions)
              .set({
                status: 'pairing',
                qrPayload: payload,
                qrExpiresAt: expiresAt,
                updatedAt: new Date(),
              })
              .where(eq(schema.waSessions.id, sessionId));
          });
        },

        onConnected: async (phoneE164) => {
          await asSystem(this.db, async (tx) => {
            const now = new Date();
            const current = await tx
              .select({ linkedAt: schema.waSessions.linkedAt })
              .from(schema.waSessions)
              .where(eq(schema.waSessions.id, sessionId))
              .limit(1);

            await tx
              .update(schema.waSessions)
              .set({
                status: 'connected',
                // linkedAt starts the warm-up clock, so it is set once and
                // never refreshed by a later reconnect.
                linkedAt: current[0]?.linkedAt ?? now,
                ...(phoneE164 ? { phoneE164 } : {}),
                lastConnectedAt: now,
                pairingCode: null,
                pairingCodeExpiresAt: null,
                qrPayload: null,
                qrExpiresAt: null,
                lastError: null,
                updatedAt: now,
              })
              .where(eq(schema.waSessions.id, sessionId));

            await tx.insert(schema.auditLog).values({
              userId,
              action: 'wa_session.connected',
              entityType: 'wa_session',
              entityId: sessionId,
              metadata: { phone: phoneE164 ? maskPhone(phoneE164) : null },
            });
          });
        },

        onThrottle: (signal, raw) => this.handleThrottle(sessionId, userId, signal, raw),

        onInboundMessage: (msg) => this.handleReply(sessionId, userId, msg),

        onReceipt: async (r) => {
          await asSystem(this.db, async (tx) => {
            // Correlate by WhatsApp's own id, which is on the target row from
            // the send. An unmatched receipt is normal — it may belong to a
            // message the user sent from their phone.
            const target = await tx
              .select({
                id: schema.campaignTargets.id,
                campaignId: schema.campaignTargets.campaignId,
                contactId: schema.campaignTargets.contactId,
              })
              .from(schema.campaignTargets)
              .where(eq(schema.campaignTargets.waMessageId, r.waMessageId))
              .limit(1);

            const hit = target[0];
            if (!hit) return;

            await tx.insert(schema.messageEvents).values({
              userId,
              sessionId,
              contactId: hit.contactId,
              campaignId: hit.campaignId,
              direction: 'out',
              type: r.type,
              waMessageId: r.waMessageId,
            });
          });
        },
      },
    });
  }

  private async persistStatus(
    sessionId: string,
    status: WaStatus,
    detail?: string,
  ): Promise<void> {
    this.log.info('session status changed', { sessionId, status, detail });

    await asSystem(this.db, async (tx) => {
      await tx
        .update(schema.waSessions)
        .set({
          status,
          lastError: detail ?? null,
          ...(status === 'logged_out' || status === 'banned'
            ? { pairingCode: null, pairingCodeExpiresAt: null, qrPayload: null, qrExpiresAt: null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.waSessions.id, sessionId));
    });

    // A dead session must not keep a socket object around claiming a slot.
    if (status === 'logged_out' || status === 'banned') {
      this.connections.delete(sessionId);
    }
  }

  /**
   * Applies the governor's response to a throttle signal.
   *
   * Everything here is deliberately conservative: drop the tier, stretch the
   * delays, and hold. Nothing reconnects, and nothing re-pairs.
   */
  private async handleThrottle(
    sessionId: string,
    userId: string,
    signal: ThrottleSignal,
    raw: unknown,
  ): Promise<void> {
    const response = THROTTLE_RESPONSE[signal];

    await asSystem(this.db, async (tx) => {
      const rows = await tx
        .select({
          tier: schema.waSessions.tier,
          delayMultiplier: schema.waSessions.delayMultiplier,
        })
        .from(schema.waSessions)
        .where(eq(schema.waSessions.id, sessionId))
        .limit(1);

      const tierBefore = rows[0]?.tier ?? 1;
      const tierAfter = response.resetToTier1
        ? 1
        : Math.max(1, tierBefore - response.tierDrop);

      const pausedUntil =
        response.pauseMs > 0 ? new Date(Date.now() + response.pauseMs) : null;

      await tx
        .update(schema.waSessions)
        .set({
          status: 'throttled',
          tier: tierAfter,
          tierUpdatedAt: new Date(),
          // Any signal invalidates the clean-day streak that earns promotion.
          cleanDays: 0,
          delayMultiplier: Math.max(
            rows[0]?.delayMultiplier ?? 1,
            response.delayMultiplier,
          ),
          ...(pausedUntil ? { throttledUntil: pausedUntil } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.waSessions.id, sessionId));

      await tx.insert(schema.throttleEvents).values({
        userId,
        sessionId,
        signal,
        raw: raw as Record<string, unknown>,
        tierBefore,
        tierAfter,
        pausedUntil,
      });

      // Stop every campaign on this number. Continuing into a cap is what
      // converts a 24-hour hold into a permanent ban.
      await tx
        .update(schema.campaigns)
        .set({
          status: 'paused',
          pausedAt: new Date(),
          pauseReason: `WhatsApp signalled ${signal}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.campaigns.sessionId, sessionId),
            eq(schema.campaigns.status, 'running'),
          ),
        );
    });

    this.log.warn('throttle handled', { sessionId, signal, response });
  }

  /**
   * Records an inbound message.
   *
   * Two things make this more than logging: a reply is the signal that the
   * recipient is a real person who engaged, which feeds tier promotion; and a
   * reply that reads as an opt-out adds a suppression, which is the one rule
   * a user cannot switch off.
   */
  private async handleReply(
    sessionId: string,
    userId: string,
    msg: { fromE164: string; body: string; waMessageId: string; at: Date },
  ): Promise<void> {
    const optOut = detectOptOut(msg.body);

    await asSystem(this.db, async (tx) => {
      const contactRows = await tx
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.userId, userId),
            eq(schema.contacts.phoneE164, msg.fromE164),
          ),
        )
        .limit(1);

      const contactId = contactRows[0]?.id ?? null;

      // Attribute the reply to the most recent campaign that messaged them.
      let campaignId: string | null = null;
      let variantId: string | null = null;
      if (contactId) {
        const target = await tx
          .select({
            campaignId: schema.campaignTargets.campaignId,
            variantId: schema.campaignTargets.variantId,
          })
          .from(schema.campaignTargets)
          .where(
            and(
              eq(schema.campaignTargets.userId, userId),
              eq(schema.campaignTargets.contactId, contactId),
              eq(schema.campaignTargets.status, 'sent'),
            ),
          )
          .orderBy(sql`${schema.campaignTargets.sentAt} desc nulls last`)
          .limit(1);
        campaignId = target[0]?.campaignId ?? null;
        variantId = target[0]?.variantId ?? null;
      }

      await tx.insert(schema.messageEvents).values({
        userId,
        sessionId,
        contactId,
        campaignId,
        direction: 'in',
        type: 'reply',
        waMessageId: msg.waMessageId || null,
        body: msg.body,
        occurredAt: msg.at,
      });

      if (contactId) {
        await tx
          .update(schema.contacts)
          .set({ lastRepliedAt: msg.at, updatedAt: new Date() })
          .where(eq(schema.contacts.id, contactId));
      }

      if (campaignId) {
        await tx
          .update(schema.campaigns)
          .set({ replyCount: sql`${schema.campaigns.replyCount} + 1`, updatedAt: new Date() })
          .where(eq(schema.campaigns.id, campaignId));
      }

      if (variantId) {
        await tx
          .update(schema.templateVariants)
          .set({
            replyCount: sql`${schema.templateVariants.replyCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(schema.templateVariants.id, variantId));
      }

      if (optOut) {
        await tx
          .insert(schema.suppressions)
          .values({
            userId,
            phoneE164: msg.fromE164,
            reason: 'opt_out',
            note: `Replied: ${msg.body.slice(0, 120)}`,
          })
          // Already suppressed is the expected case on a second "stop".
          .onConflictDoNothing();

        // Pull them out of anything still queued, so the opt-out takes effect
        // immediately rather than at the end of the current campaign.
        if (contactId) {
          await tx
            .update(schema.campaignTargets)
            .set({ status: 'skipped', skipReason: 'suppressed' })
            .where(
              and(
                eq(schema.campaignTargets.userId, userId),
                eq(schema.campaignTargets.contactId, contactId),
                eq(schema.campaignTargets.status, 'pending'),
              ),
            );
        }

        await tx.insert(schema.auditLog).values({
          userId,
          action: 'suppression.opt_out',
          entityType: 'contact',
          entityId: contactId,
          metadata: { phone: maskPhone(msg.fromE164) },
        });
      }
    });

    this.log.info('inbound message recorded', {
      sessionId,
      from: maskPhone(msg.fromE164),
      optOut,
    });
  }
}

/** Sessions the worker should hold a socket for. */
export async function listResumableSessions(db: Database): Promise<
  { id: string; userId: string; credsEncrypted: string | null }[]
> {
  return asSystem(db, async (tx) =>
    tx
      .select({
        id: schema.waSessions.id,
        userId: schema.waSessions.userId,
        credsEncrypted: schema.waSessions.credsEncrypted,
      })
      .from(schema.waSessions)
      .where(
        and(
          isNull(schema.waSessions.deletedAt),
          // 'connected' and 'disconnected' both mean "we have credentials and
          // should be online". 'throttled' deliberately stays offline until
          // the hold expires.
          sql`${schema.waSessions.status} in ('connected', 'disconnected')`,
          sql`${schema.waSessions.credsEncrypted} is not null`,
        ),
      ),
  );
}
