import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import pdfParse from "pdf-parse";
import { DocumentPart } from "../domain/ragTypes.js";

export type ParsedDocument = {
  parts: DocumentPart[];
  ocr_status: "completed" | "skipped";
  parser_kind: "pdf" | "markdown" | "csv" | "xlsx" | "text";
};

export async function parseDocument(
  documentId: string,
  filename: string,
  mimeType: string,
  body: Buffer
): Promise<ParsedDocument> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if (mimeType.includes("pdf") || ext === "pdf") {
    return parsePdf(documentId, body);
  }

  if (mimeType.includes("sheet") || ext === "xlsx") {
    return parseXlsx(documentId, body);
  }

  if (mimeType.includes("csv") || ext === "csv") {
    return parseCsv(documentId, body);
  }

  if (ext === "md" || mimeType.includes("markdown")) {
    return parseMarkdown(documentId, body);
  }

  return parseText(documentId, body);
}

async function parsePdf(documentId: string, body: Buffer): Promise<ParsedDocument> {
  const pageMarker = "__RAG_PDF_PAGE__";

  try {
    let pageCounter = 0;
    const parsed = await pdfParse(body, {
      pagerender: async (pageData: any): Promise<string> => {
        pageCounter += 1;
        const textContent = await pageData.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false
        });

        let lastY: number | undefined;
        let text = "";

        for (const item of textContent.items as Array<{ str?: string; transform?: number[] }>) {
          const currentY = item.transform?.[5];
          if (typeof currentY === "number" && typeof lastY === "number" && currentY !== lastY) {
            text += "\n";
          }

          text += item.str ?? "";
          lastY = currentY;
        }

        return `${pageMarker}${pageCounter}\n${text}`;
      }
    });
    const parts = extractPdfParts(documentId, parsed.text ?? "", pageMarker);

    return {
      parts,
      ocr_status: "skipped",
      parser_kind: "pdf"
    };
  } catch {
    return {
      parts: [
        {
          id: uuidv4(),
          document_id: documentId,
          page_or_sheet: "page-1",
          raw_text: "",
          metadata_json: { parser: "pdf-parse", failed: true }
        }
      ],
      ocr_status: "skipped",
      parser_kind: "pdf"
    };
  }
}

function extractPdfParts(documentId: string, fullText: string, marker: string): DocumentPart[] {
  const markerRegex = new RegExp(`${escapeRegExp(marker)}(\\d+)\\n`, "g");
  const matches: Array<{ pageNumber: number; markerStart: number; contentStart: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = markerRegex.exec(fullText)) !== null) {
    const pageNumber = Number.parseInt(match[1], 10);
    if (Number.isNaN(pageNumber)) {
      continue;
    }

    matches.push({
      pageNumber,
      markerStart: match.index,
      contentStart: match.index + match[0].length
    });
  }

  if (matches.length === 0) {
    return [
      {
        id: uuidv4(),
        document_id: documentId,
        page_or_sheet: "page-1",
        raw_text: fullText.trim(),
        metadata_json: { parser: "pdf-parse" }
      }
    ];
  }

  const parts: DocumentPart[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const rawText = fullText.slice(current.contentStart, next?.markerStart ?? fullText.length).trim();

    parts.push({
      id: uuidv4(),
      document_id: documentId,
      page_or_sheet: `page-${current.pageNumber}`,
      raw_text: rawText,
      metadata_json: { parser: "pdf-parse", page: current.pageNumber }
    });
  }

  return parts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseXlsx(documentId: string, body: Buffer): ParsedDocument {
  const workbook = XLSX.read(body, { type: "buffer" });
  const parts: DocumentPart[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(sheet, {
      header: 1,
      blankrows: false
    });

    const text = rows
      .map((row) => row.map((cell) => String(cell ?? "")).join(" | "))
      .filter((row) => row.trim().length > 0)
      .join("\n");

    parts.push({
      id: uuidv4(),
      document_id: documentId,
      page_or_sheet: sheetName,
      raw_text: text,
      metadata_json: {
        parser: "xlsx",
        rows: rows.length
      }
    });
  }

  return {
    parts,
    ocr_status: "skipped",
    parser_kind: "xlsx"
  };
}

function parseCsv(documentId: string, body: Buffer): ParsedDocument {
  const text = body.toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  return {
    parts: [
      {
        id: uuidv4(),
        document_id: documentId,
        page_or_sheet: "sheet-1",
        raw_text: lines.join("\n"),
        metadata_json: { parser: "csv", rows: lines.length }
      }
    ],
    ocr_status: "skipped",
    parser_kind: "csv"
  };
}

function parseMarkdown(documentId: string, body: Buffer): ParsedDocument {
  const text = body.toString("utf8");
  const sections = text.split(/^#{1,6}\s+/gm).map((section) => section.trim()).filter(Boolean);

  if (sections.length === 0) {
    return parseText(documentId, body);
  }

  return {
    parts: sections.map((section, index) => ({
      id: uuidv4(),
      document_id: documentId,
      page_or_sheet: `section-${index + 1}`,
      raw_text: section,
      metadata_json: { parser: "markdown" }
    })),
    ocr_status: "skipped",
    parser_kind: "markdown"
  };
}

function parseText(documentId: string, body: Buffer): ParsedDocument {
  return {
    parts: [
      {
        id: uuidv4(),
        document_id: documentId,
        page_or_sheet: "text-1",
        raw_text: body.toString("utf8"),
        metadata_json: { parser: "text" }
      }
    ],
    ocr_status: "skipped",
    parser_kind: "text"
  };
}
