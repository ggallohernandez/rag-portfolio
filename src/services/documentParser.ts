import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import pdfParse from "pdf-parse";
import { DocumentPart } from "../domain/ragTypes.js";

export type ParsedDocument = {
  parts: DocumentPart[];
  ocr_status: "completed" | "skipped";
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
  try {
    const parsed = await pdfParse(body);
    const text = parsed.text?.trim() ?? "";

    return {
      parts: [
        {
          id: uuidv4(),
          document_id: documentId,
          page_or_sheet: "page-1",
          raw_text: text,
          metadata_json: { parser: "pdf-parse" }
        }
      ],
      ocr_status: "skipped"
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
      ocr_status: "skipped"
    };
  }
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
    ocr_status: "skipped"
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
    ocr_status: "skipped"
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
    ocr_status: "skipped"
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
    ocr_status: "skipped"
  };
}
