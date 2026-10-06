// Sends in a sandbox (DESIGN.md, "Sends"): Kestrel's own sweep, driven by the sandbox DO's
// alarm, delivers a scheduled send through the fake transport; the alarm is armed only when
// there's something to send; and nothing can reach the network.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkSandboxConfig, sandboxEnv } from "../src/sandbox";
import { SAME_ORIGIN, type Visitor, visitor } from "./support";

interface SendView {
  id: string;
  status: string;
  fire_at: number;
  counts?: Record<string, number>;
}

async function draftId(v: Visitor): Promise<string> {
  const { body } = await v.json<{ posts: { id: string }[] }>("/posts?status=draft");
  const id = body.posts[0]?.id;
  if (!id) {
    throw new Error("no draft");
  }
  return id;
}

async function alarmAt(v: Visitor): Promise<number | null> {
  return runInDurableObject(await v.sandbox(), (_i, state) => state.storage.getAlarm());
}

async function scheduledSends(v: Visitor): Promise<SendView[]> {
  const { body } = await v.json<{ sends: SendView[] }>("/sends?status=scheduled");
  return body.sends;
}

describe("the sweep alarm", () => {
  it("is armed for the earliest scheduled send", async () => {
    const v = visitor();
    const seeded = await scheduledSends(v);
    expect(seeded).toHaveLength(1); // the seed's "A quick note", two days out
    expect(await alarmAt(v)).toBe(seeded[0]?.fire_at);
  });

  it("is cleared when nothing is scheduled or sending", async () => {
    const v = visitor();
    for (const send of await scheduledSends(v)) {
      // No body, so no content type: a cancel declares none.
      const res = await v.fetch(`/sends/${send.id}/cancel`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(res.status).toBe(200);
    }
    expect(await scheduledSends(v)).toEqual([]);
    expect(await alarmAt(v)).toBeNull();
  });
});

describe("a scheduled send", () => {
  it("goes out through the fake transport when its alarm fires, with no network egress", async () => {
    const v = visitor();
    await v.fetch("/posts");
    const stub = await v.sandbox();
    const refusedBefore = await runInDurableObject(stub, (i) => i.egressRefused());
    const post = await draftId(v);
    const scheduled = await v.fetch(`/posts/${post}/schedule`, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ fire_at: Date.now() + 61_000 }),
    });
    expect(scheduled.status).toBe(201);
    const { send } = (await scheduled.json()) as { send: SendView };
    expect(send.status).toBe("scheduled");

    // The alarm is armed for the earlier of the two scheduled sends: this one.
    expect(await alarmAt(v)).toBe(send.fire_at);

    // Let the fire time pass (the test can't wait a minute), then fire the alarm.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "UPDATE sends SET fire_at = ? WHERE id = ?",
        Date.now() - 1000,
        send.id,
      );
    });
    // The alarm armed for the original fire time runs now.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const after = await v.json<{ send: SendView & { status: string } }>(`/sends/${send.id}`);
    expect(after.status).toBe(200);
    expect(after.body.send.status).toBe("sent");
    const accepted = await runInDurableObject(
      stub,
      (_i, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM deliveries WHERE send_id = ? AND status = 'accepted'",
            send.id,
          )
          .one().n,
    );
    expect(accepted).toBeGreaterThan(100);
    expect(await runInDurableObject(stub, (i) => i.egressRefused())).toBe(refusedBefore);

    // Only the seed's send is left, so the alarm goes back to it.
    const remaining = await scheduledSends(v);
    expect(remaining).toHaveLength(1);
    expect(await alarmAt(v)).toBe(remaining[0]?.fire_at);
  });
});

describe("network egress", () => {
  it("is refused for any fetch inside a sandbox", async () => {
    const v = visitor();
    await v.fetch("/posts");
    await runInDurableObject(await v.sandbox(), async (instance) => {
      const before = instance.egressRefused();
      await expect(fetch("https://example.com/")).rejects.toThrow(
        /outbound network access is disabled/,
      );
      await expect(fetch(new Request("https://api.resend.com/emails/batch"))).rejects.toThrow(
        /outbound network access is disabled/,
      );
      expect(instance.egressRefused()).toBe(before + 2);
    });
  });

  it("isn't attempted by Kestrel's webhook routes, which the fake transport answers", async () => {
    // With a real SES provider this message would make Kestrel fetch the signing certificate
    // and the subscribe URL. In a sandbox the active provider is always the fake, whose
    // parseWebhook makes no request; the egress block is the backstop if that ever changed.
    const v = visitor();
    await v.fetch("/posts");
    const stub = await v.sandbox();
    const before = await runInDurableObject(stub, (i) => i.egressRefused());
    const res = await v.fetch("/webhooks/ses", {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=UTF-8",
        "x-amz-sns-message-type": "SubscriptionConfirmation",
      },
      body: JSON.stringify({
        Type: "SubscriptionConfirmation",
        MessageId: "m-1",
        Token: "t",
        TopicArn: "arn:aws:sns:us-east-1:123456789012:kestrel",
        Message: "confirm",
        SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t",
        Timestamp: new Date().toISOString(),
        SignatureVersion: "1",
        Signature: "c2ln",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem",
      }),
    });
    await res.arrayBuffer();
    expect(await runInDurableObject(stub, (i) => i.egressRefused())).toBe(before);
  });
});

describe("the sandbox config", () => {
  it("runs Kestrel only on the fake transport", () => {
    const fake = sandboxEnv(env, {} as D1Database, {} as R2Bucket);
    expect(() => checkSandboxConfig(fake)).not.toThrow();
    // Kestrel's own config check refuses a real provider without credentials first.
    expect(() => checkSandboxConfig({ ...fake, PROVIDER: "ses" })).toThrow();
    expect(() =>
      checkSandboxConfig({ ...fake, NOTIFY: {} } as unknown as ReturnType<typeof sandboxEnv>),
    ).toThrow(/only on the fake transport/);
  });
});
