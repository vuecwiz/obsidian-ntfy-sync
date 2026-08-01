import {
  publishConfiguredMessage,
  publishConfiguredTestMessage,
} from "../../src/app/test-publisher";
import { createDefaultSettings } from "../../src/settings/defaults";

function settingsFixture() {
  const settings = createDefaultSettings();
  settings.connections = [
    {
      id: "primary",
      name: "test",
      baseUrl: "http://127.0.0.1:9",
      topics: ["alpha"],
      readAuth: { kind: "none" },
      mode: "poll",
      pollIntervalSeconds: 30,
      allowInsecureHttp: true,
      initialReplay: { kind: "latest" },
      reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
    },
  ];
  return settings;
}

describe("configured test publisher validation", () => {
  it("rejects topics outside the configured input topic list", async () => {
    await expect(
      publishConfiguredTestMessage(settingsFixture(), {
        topic: "beta",
        message: "hello",
        priority: 3,
      }),
    ).rejects.toMatchObject({ code: "TOPIC_INVALID" });
  });

  it("rejects blank and oversized messages before network I/O", async () => {
    const settings = settingsFixture();
    await expect(
      publishConfiguredTestMessage(settings, { topic: "alpha", message: "  \n", priority: 3 }),
    ).rejects.toMatchObject({ code: "MESSAGE_REQUIRED" });
    settings.processing.maxBodyBytes = 3;
    await expect(
      publishConfiguredTestMessage(settings, { topic: "alpha", message: "四五", priority: 3 }),
    ).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
  });

  it("allows an attachment without a message and rejects oversized files", async () => {
    const settings = settingsFixture();
    settings.processing.maxAttachmentBytes = 3;
    await expect(
      publishConfiguredTestMessage(settings, {
        topic: "alpha",
        message: "",
        priority: 3,
        attachment: { name: "example.txt", data: new ArrayBuffer(4) },
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("allows a valid outbound topic that is not subscribed while test publishing stays restricted", async () => {
    const settings = settingsFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      publishConfiguredMessage(
        settings,
        { topic: "mobile_notifications", message: "hello", priority: 3 },
        {},
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      publishConfiguredTestMessage(settings, {
        topic: "mobile_notifications",
        message: "hello",
        priority: 3,
      }),
    ).rejects.toMatchObject({ code: "TOPIC_INVALID" });
  });

  it("rejects invalid outbound topics, oversized titles and malformed tags before network I/O", async () => {
    const settings = settingsFixture();
    await expect(
      publishConfiguredMessage(settings, { topic: "bad/topic", message: "hello", priority: 3 }),
    ).rejects.toMatchObject({ code: "TOPIC_INVALID" });
    await expect(
      publishConfiguredMessage(settings, {
        topic: "alpha",
        title: "四".repeat(1_500),
        message: "hello",
        priority: 3,
      }),
    ).rejects.toMatchObject({ code: "TITLE_TOO_LARGE" });
    await expect(
      publishConfiguredMessage(settings, {
        topic: "alpha",
        message: "hello",
        priority: 3,
        tags: ["valid", "bad,tag"],
      }),
    ).rejects.toMatchObject({ code: "TAGS_INVALID" });
  });

  it.each([
    [{ clickUrl: "javascript:alert(1)" }, "CLICK_URL_INVALID"],
    [{ email: "two@example.com,three@example.com" }, "EMAIL_INVALID"],
    [{ delay: "tomorrow\n9am" }, "DELAY_INVALID"],
    [{ attachmentUrl: "file:///tmp/example.png" }, "ATTACHMENT_URL_INVALID"],
    [{ filename: "folder/example.png" }, "FILENAME_INVALID"],
  ] as const)("rejects invalid optional publish fields %#", async (fields, code) => {
    await expect(
      publishConfiguredMessage(settingsFixture(), {
        topic: "alpha",
        message: "hello",
        priority: 3,
        ...fields,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("rejects simultaneous local and remote attachments", async () => {
    await expect(
      publishConfiguredMessage(settingsFixture(), {
        topic: "alpha",
        message: "",
        priority: 3,
        attachmentUrl: "https://example.com/image.png",
        attachment: { name: "image.png", data: new ArrayBuffer(1) },
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_CONFLICT" });
  });

  it("accepts official click, email and delay forms before an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      publishConfiguredMessage(
        settingsFixture(),
        {
          topic: "alpha",
          message: "hello",
          priority: 3,
          clickUrl: "mailto:mobile@example.com",
          email: "mobile@example.com",
          delay: "tomorrow, 9am",
        },
        {},
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
