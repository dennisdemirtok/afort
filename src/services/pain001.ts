import { create } from "xmlbuilder2";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import { Invoice } from "../models/invoice";
import { createPaymentFile } from "../models/payment-file";

export function generatePain001(invoices: Invoice[], executionDate: string) {
  const msgId = `BATCH-${executionDate}-${Date.now().toString(36)}`;
  const totalAmount = invoices.reduce((sum, inv) => sum + (inv.amount || 0), 0);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "");

  const doc = create({ version: "1.0", encoding: "UTF-8" })
    .ele("Document", {
      xmlns: "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03",
      "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
    })
    .ele("CstmrCdtTrfInitn")
      .ele("GrpHdr")
        .ele("MsgId").txt(msgId).up()
        .ele("CreDtTm").txt(now).up()
        .ele("NbOfTxs").txt(String(invoices.length)).up()
        .ele("CtrlSum").txt(totalAmount.toFixed(2)).up()
        .ele("InitgPty")
          .ele("Nm").txt(env.companyName).up()
          .ele("Id")
            .ele("OrgId")
              .ele("Othr")
                .ele("Id").txt(env.orgNumber).up()
              .up()
            .up()
          .up()
        .up()
      .up();

  // Payment Information block
  const pmtInf = doc.ele("PmtInf");
  pmtInf.ele("PmtInfId").txt(`PAY-${Date.now().toString(36)}`);
  pmtInf.ele("PmtMtd").txt("TRF");
  pmtInf.ele("NbOfTxs").txt(String(invoices.length));
  pmtInf.ele("CtrlSum").txt(totalAmount.toFixed(2));
  pmtInf.ele("ReqdExctnDt").txt(executionDate);

  // Debtor
  pmtInf.ele("Dbtr").ele("Nm").txt(env.companyName);
  pmtInf.ele("DbtrAcct").ele("Id").ele("IBAN").txt(env.debtorIban);
  pmtInf.ele("DbtrAgt").ele("FinInstnId").ele("BIC").txt(env.debtorBic);

  // Credit Transfer Transactions
  for (const inv of invoices) {
    const tx = pmtInf.ele("CdtTrfTxInf");

    tx.ele("PmtId")
      .ele("EndToEndId").txt(inv.invoice_number || inv.id.substring(0, 16));

    tx.ele("Amt")
      .ele("InstdAmt", { Ccy: inv.currency || "SEK" })
      .txt((inv.amount || 0).toFixed(2));

    // Creditor account - bankgiro, plusgiro, or IBAN
    if (inv.iban) {
      tx.ele("CdtrAcct").ele("Id").ele("IBAN").txt(inv.iban);
    } else if (inv.bankgiro) {
      tx.ele("CdtrAcct").ele("Id").ele("Othr")
        .ele("Id").txt(inv.bankgiro.replace("-", "")).up()
        .ele("SchmeNm").ele("Prtry").txt("BGNR");
    } else if (inv.plusgiro) {
      tx.ele("CdtrAcct").ele("Id").ele("Othr")
        .ele("Id").txt(inv.plusgiro.replace("-", "")).up()
        .ele("SchmeNm").ele("Prtry").txt("PGNR");
    }

    // Creditor name
    if (inv.vendor_name) {
      tx.ele("Cdtr").ele("Nm").txt(inv.vendor_name);
    }

    // Remittance info - OCR or invoice number
    if (inv.ocr) {
      tx.ele("RmtInf").ele("Strd").ele("CdtrRefInf")
        .ele("Tp").ele("CdOrPrtry").ele("Cd").txt("SCOR").up().up().up()
        .ele("Ref").txt(inv.ocr);
    } else if (inv.invoice_number) {
      tx.ele("RmtInf").ele("Ustrd").txt(inv.invoice_number);
    }
  }

  const xmlString = doc.end({ prettyPrint: true });

  // Save file
  fs.mkdirSync(env.paymentFilesDir, { recursive: true });
  const filename = `pain001_${executionDate}_${Date.now()}.xml`;
  const filePath = path.join(env.paymentFilesDir, filename);
  fs.writeFileSync(filePath, xmlString, "utf-8");

  // Create DB record
  const paymentFile = createPaymentFile({
    filename,
    file_path: filePath,
    num_transactions: invoices.length,
    total_amount: totalAmount,
    currency: "SEK",
    execution_date: executionDate,
  });

  return { paymentFile, xml: xmlString, filePath };
}
