import { normalizeVaultPath, sanitizePathComponent } from "../../src/effects/paths";
import { formatUtcDate, renderTemplate, validateTemplate } from "../../src/templates/engine";
import { message } from "../helpers/message";

describe("templates and paths", () => {
  it("renders the supported variable catalog deterministically", () => {
    const result = renderTemplate(
      "{{messageDate:YYYY-MM-DD}} {{messageTime:HH:mm:ss.SSS}} {{content:3}} {{tag:[0]}}",
      { message: message({ body: "abcdef", tags: ["one"] }) },
    );
    expect(result).toBe("2026-07-29 04:05:06.007 abc one");
    expect(formatUtcDate(0, "YYYYMMDD")).toBe("19700101");
  });

  it("blocks unknown variables and date formats", () => {
    expect(validateTemplate("{{unknown}}")).toContain("Unknown template variable: unknown");
    expect(() => renderTemplate("{{messageDate:YYYY[bad]}}", { message: message() })).toThrow(
      "date format",
    );
  });

  it("renders optional, URL, attachment and file variables", () => {
    const value = message({
      source: { sequenceId: "sequence" },
      title: "title",
      tags: ["one", "two"],
      firstUrl: {
        raw: "https://example.com/path",
        protocol: "https:",
        hostname: "example.com",
      },
      attachment: {
        name: "file.pdf",
        url: "https://ntfy.example/file",
        type: "application/pdf",
      },
    });
    const rendered = renderTemplate(
      "{{title}}|{{topic}}|{{messageId}}|{{sequenceId}}|{{priority}}|{{tags}}|" +
        "{{tag:[1]}}|{{tag:[9]}}|{{url1}}|{{url1:host}}|{{attachment:name}}|" +
        "{{attachment:type}}|{{file:path}}|{{file:link}}|{{file:embed}}|" +
        "{{receivedDate:YYYYMMDD}}",
      {
        message: value,
        file: { path: "a/file.pdf", link: "[[a/file.pdf]]", embed: "![[a/file.pdf]]" },
      },
    );
    expect(rendered).toContain("title|test-topic|AbCd123456|sequence|3|one, two|two||");
    expect(rendered).toContain("https://example.com/path|example.com|file.pdf|application/pdf");
    expect(rendered).toContain("a/file.pdf|[[a/file.pdf]]|![[a/file.pdf]]|20260729");
    expect(
      renderTemplate(
        "{{sequenceId}}{{url1}}{{url1:host}}{{attachment:name}}{{attachment:type}}" +
          "{{file:path}}{{file:link}}{{file:embed}}{{messageTime:HHmm}}",
        { message: message() },
      ),
    ).toBe("0405");
    expect(
      renderTemplate("{{attachment:type}}", {
        message: message({
          attachment: { name: "unknown", url: "https://ntfy.example/file" },
        }),
      }),
    ).toBe("");
  });

  it("validates supported templates without issues and hides path token details", () => {
    expect(validateTemplate("{{content}} {{messageDate:YYYY-MM-DD}}")).toEqual([]);
    expect(validateTemplate("{{not-allowed}}", true)).toEqual([
      "Unknown template variable: <path-token>",
    ]);
  });

  it.each(["../escape.md", "/absolute.md", "C:\\escape.md", "a//b.md", "./note.md"])(
    "rejects unsafe path %s",
    (path) => expect(() => normalizeVaultPath(path, { requireMarkdown: true })).toThrow(),
  );

  it("normalizes safe paths and components", () => {
    expect(normalizeVaultPath("Obsidian/ntfy/note.md", { requireMarkdown: true })).toBe(
      "Obsidian/ntfy/note.md",
    );
    expect(sanitizePathComponent("../bad:name")).toBe("_bad_name");
    expect(() => normalizeVaultPath("note.txt", { requireMarkdown: true })).toThrow(".md");
  });
});
