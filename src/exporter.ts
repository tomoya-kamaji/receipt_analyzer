// src/exporter.ts
import { createObjectCsvWriter } from "csv-writer";
import { type Receipt } from "./parser";

export class ReceiptExporter {
  // 基本的なCSV出力
  static async exportToCSV(
    receipts: Receipt[],
    outputPath: string
  ): Promise<void> {
    const csvWriter = createObjectCsvWriter({
      path: outputPath,
      header: [
        { id: "id", title: "ID" },
        { id: "date", title: "日付" },
        { id: "storeName", title: "店舗名" },
        { id: "amount", title: "金額" },
        { id: "taxAmount", title: "消費税" },
        { id: "category", title: "カテゴリ" },
        { id: "paymentMethod", title: "支払方法" },
      ],
    });

    await csvWriter.writeRecords(receipts);
    console.log(`CSVファイルを出力しました: ${outputPath}`);
  }

  // 会計ソフト用CSV出力
  static async exportToAccountingFormat(
    receipts: Receipt[],
    outputPath: string
  ): Promise<void> {
    const accountingData = receipts.map((receipt) => ({
      日付: receipt.date,
      内容: receipt.storeName,
      勘定科目: this.mapCategoryToAccount(receipt.category || "その他"),
      金額: receipt.amount,
      備考: `領収書ID: ${receipt.id}`,
      税区分: "課税",
      税額: receipt.taxAmount || Math.floor(receipt.amount * 0.1),
    }));

    const csvWriter = createObjectCsvWriter({
      path: outputPath,
      header: [
        { id: "日付", title: "日付" },
        { id: "内容", title: "内容" },
        { id: "勘定科目", title: "勘定科目" },
        { id: "金額", title: "金額" },
        { id: "備考", title: "備考" },
        { id: "税区分", title: "税区分" },
        { id: "税額", title: "税額" },
      ],
    });

    await csvWriter.writeRecords(accountingData);
    console.log(`会計ソフト用CSVを出力しました: ${outputPath}`);
  }

  // カテゴリから勘定科目へのマッピング
  private static mapCategoryToAccount(category: string): string {
    const mapping: { [key: string]: string } = {
      飲食: "会議費",
      食料品: "消耗品費",
      交通費: "旅費交通費",
      宿泊: "旅費交通費",
      "文具・書籍": "消耗品費",
      "医療・健康": "福利厚生費",
      その他: "雑費",
    };

    return mapping[category] || "雑費";
  }
}
