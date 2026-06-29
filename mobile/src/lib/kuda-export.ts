import * as XLSX from 'xlsx';

// Kuda bulk-payout Excel file. Kuda's official upload is an .xlsx with a single
// "BULK_LIST" sheet and the columns below in order:
//   Account_Number, Amount, Bank_Codes, Narration
// We mirror that exactly. Account_Number and Bank_Codes are written as TEXT
// cells so leading zeros survive (NUBANs and codes like "000014" must not be
// truncated to a number). Amount is a real number cell; Narration is text.
// The bank name is mapped to a 6-digit Kuda code by the caller
// (kudaCodeForBankName) before a row reaches here.

/** One beneficiary line for the Kuda bulk-transfer file. Callers pass only
 *  vendors with complete bank details, a resolvable Kuda code, and a positive
 *  payout. */
export type KudaPayoutRow = {
  accountNumber: string;
  amount: number;
  bankCode: string;
  narration: string;
};

const KUDA_HEADERS = ['Account_Number', 'Amount', 'Bank_Codes', 'Narration'] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build the Kuda bulk-transfer .xlsx (BULK_LIST sheet). Returns the workbook
 *  bytes as an ArrayBuffer, ready to wrap in a Blob for download. */
export function buildKudaPayoutXlsx(rows: KudaPayoutRow[]): ArrayBuffer {
  // Array-of-arrays drives the cell types: JS strings -> text cells (leading
  // zeros preserved), JS numbers -> numeric cells.
  const aoa: (string | number)[][] = [
    [...KUDA_HEADERS],
    ...rows.map((r) => [
      String(r.accountNumber),
      round2(r.amount),
      String(r.bankCode),
      r.narration,
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'BULK_LIST');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
