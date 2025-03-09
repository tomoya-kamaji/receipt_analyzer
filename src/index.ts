import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { ReceiptAnalyzer } from "./receiptAnalyzer";

// 環境変数の読み込み
dotenv.config();

// 実行用の関数
async function main() {
  try {
    // 入出力パスを設定
    const directoryPath = "./receipts";
    const outputPath = "./output/receipts_raw.csv";

    // 出力ディレクトリが存在することを確認
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 領収書解析クラスのインスタンスを作成
    const analyzer = new ReceiptAnalyzer();

    console.log(`ディレクトリの処理を開始: ${directoryPath}`);

    // ディレクトリ内の全ての領収書画像を処理
    const receipts = await analyzer.processDirectory(directoryPath);

    // 結果を出力
    if (receipts.length > 0) {
      analyzer.saveAsCsv(receipts, outputPath);
      console.log(`処理完了: ${receipts.length}件の領収書を解析しました`);
    } else {
      console.log("処理された領収書はありません");
    }
  } catch (error) {
    console.error("エラーが発生しました:", error);
    process.exit(1);
  }
}

// スクリプトの実行
main().catch(console.error);
