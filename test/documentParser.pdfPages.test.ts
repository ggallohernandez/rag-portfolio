import pdfParse from "pdf-parse";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "../src/services/documentParser.js";

vi.mock("pdf-parse", () => ({
  default: vi.fn()
}));

describe("PDF document parser", () => {
  const mockedPdfParse = vi.mocked(pdfParse);

  beforeEach(() => {
    mockedPdfParse.mockReset();
  });

  it("preserves page references as individual document parts", async () => {
    mockedPdfParse.mockResolvedValue({
      numpages: 2,
      text: "\n\n__RAG_PDF_PAGE__1\nFirst page text\n\n__RAG_PDF_PAGE__2\nSecond page text"
    } as any);

    const parsed = await parseDocument("doc-1", "sample.pdf", "application/pdf", Buffer.from("pdf"));

    expect(parsed.parts.map((part) => part.page_or_sheet)).toEqual(["page-1", "page-2"]);
    expect(parsed.parts[0].raw_text).toBe("First page text");
    expect(parsed.parts[1].raw_text).toBe("Second page text");
  });

  it("falls back to page-1 when marker metadata is missing", async () => {
    mockedPdfParse.mockResolvedValue({
      numpages: 1,
      text: "Single page text without markers"
    } as any);

    const parsed = await parseDocument("doc-2", "sample.pdf", "application/pdf", Buffer.from("pdf"));

    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0].page_or_sheet).toBe("page-1");
    expect(parsed.parts[0].raw_text).toBe("Single page text without markers");
  });
});
