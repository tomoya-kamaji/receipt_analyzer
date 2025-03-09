import { ImageAnnotatorClient } from "@google-cloud/vision";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import sharp from "sharp";
import { createObjectCsvWriter } from "csv-writer";

// 環境変数の読み込み
dotenv.config();

// 領収書のデータ構造を定義
interface Receipt {
  id: string;
  storeName: string;
  date: string;
  amount: number;
  items: ReceiptItem[];
  taxAmount?: number;
  paymentMethod?: string;
  rawText: string;
  category?: string;
}

interface ReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

interface PromptTemplate {
  fieldName: string;
  patterns: RegExp[];
  processor?: (value: string) => any;
  fallback?: (text: string) => any;
}

// プロンプトテンプレートの定義
const japaneseReceiptPrompts: PromptTemplate[] = [
  {
    fieldName: "storeName",
    patterns: [
      /店名[:|：]\s*(.+)/i,
      /(.+)\s*\n.*領収/i,
      /(.{2,20})\s*\n.*[0-9]{3}-[0-9]{4}/i, // 郵便番号の前の行が店名の可能性
      /商号名称[:：\s]*(.*?)[\s\n]/i,
      /屋号[：:]\s*(.*?)[\s\n]/i,
    ],
    fallback: (text: string) => {
      // 最初の非空行を店名候補とする
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      return lines.length > 0 ? lines[0].trim() : "不明な店舗";
    },
  },
  {
    fieldName: "date",
    patterns: [
      /日付[：:]\s*(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/i,
      /(\d{4})[年\/\.\-](\d{1,2})[月\/\.\-](\d{1,2})[日]?/i,
      /(\d{2})[\/\.](\d{1,2})[\/\.](\d{1,2})/i,
      /(\d{1,2})月(\d{1,2})日/i,
    ],
    processor: (match: string) => {
      // 正規表現のマッチ結果から日付を標準形式に変換
      const parts = match
        .split(/[年月日\/\.\-]/g)
        .filter((p) => p.trim().length > 0);
      if (parts.length >= 3) {
        let year = parts[0];
        if (year.length === 2) {
          year = `20${year}`; // 2桁の年を4桁に変換
        }
        return `${year}-${parts[1].padStart(2, "0")}-${parts[2].padStart(
          2,
          "0"
        )}`;
      } else if (parts.length === 2) {
        const currentYear = new Date().getFullYear();
        return `${currentYear}-${parts[0].padStart(2, "0")}-${parts[1].padStart(
          2,
          "0"
        )}`;
      }
      return null;
    },
  },
  {
    fieldName: "amount",
    patterns: [
      /合計[金額]*[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /(?:小計|お買上げ|計)[^\\¥\d]*[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /(?:total|金額)[^\\¥\d]*[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /(?:お会計|ご請求額|請求金額)[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /(?:￥|¥)[\s]*(\d[\d,]+)(?:\s*$|\s*円)/im,
    ],
    processor: (value: string) => parseInt(value.replace(/,/g, ""), 10),
    fallback: (text: string) => {
      // 金額らしき数値パターンを探す
      const currencyValues = text.match(/(?:￥|¥)[\s]*(\d[\d,]+)/g);
      if (currencyValues && currencyValues.length > 0) {
        // 最大値を取得
        const amounts = currencyValues.map((v) => {
          const num = v.replace(/[^\d,]/g, "").replace(/,/g, "");
          return parseInt(num, 10);
        });
        return Math.max(...amounts);
      }
      return 0;
    },
  },
  {
    fieldName: "taxAmount",
    patterns: [
      /消費税[額]?[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /内税[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /外税[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /税額[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /税[\s:：]*(\d[\d,]+)(?:\s*$|\s*円)/i,
    ],
    processor: (value: string) => parseInt(value.replace(/,/g, ""), 10),
  },
  {
    fieldName: "paymentMethod",
    patterns: [
      /(?:支払[方法い]|お支払い方法)[\s:：]*(.+?)(?:[\s\n]|$)/i,
      /(クレジット|カード|デビット|現金|電子マネー|QRコード|PayPay|メルペイ|交通系|Suica|PASMO)/i,
    ],
  },
];

class ReceiptAnalyzer {
  private client: ImageAnnotatorClient;

  constructor() {
    this.client = new ImageAnnotatorClient();
  }

  // 領収書の向きを補正し、OCR向けに前処理する
  private async preprocessImage(imageBuffer: Buffer): Promise<Buffer> {
    try {
      return await sharp(imageBuffer)
        .rotate() // EXIFの回転情報に基づいて自動回転
        .grayscale() // グレースケールに変換
        .normalise() // コントラスト正規化
        .sharpen() // シャープ化
        .toBuffer();
    } catch (error) {
      console.error("画像前処理エラー:", error);
      return imageBuffer; // エラー時は元の画像を返す
    }
  }

  // OCR結果のテキストを後処理
  private postprocessText(text: string): string {
    return text
      .replace(/\s+/g, " ") // 連続する空白を単一の空白に
      .replace(/０/g, "0")
      .replace(/１/g, "1")
      .replace(/２/g, "2")
      .replace(/３/g, "3")
      .replace(/４/g, "4")
      .replace(/５/g, "5")
      .replace(/６/g, "6")
      .replace(/７/g, "7")
      .replace(/８/g, "8")
      .replace(/９/g, "9") // 全角数字を半角に
      .replace(/，/g, ",")
      .replace(/．/g, ".") // 全角記号を半角に
      .replace(/\n\s*\n/g, "\n"); // 空行の削除
  }

  // プロンプトを使用してフィールドを抽出する
  private extractFieldWithPrompt(text: string, prompt: PromptTemplate): any {
    // パターンに基づいて抽出を試みる
    for (const pattern of prompt.patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const value = match[1].trim();
        return prompt.processor ? prompt.processor(value) : value;
      }
    }

    // フォールバック処理
    if (prompt.fallback) {
      return prompt.fallback(text);
    }

    return undefined;
  }

  // 商品アイテムを抽出する
  private extractItems(text: string): ReceiptItem[] {
    const items: ReceiptItem[] = [];

    // 行ごとに処理
    const lines = text.split("\n");
    for (const line of lines) {
      // 商品行のパターン: 商品名 数量 単価 金額
      const itemPattern =
        /(.+?)\s+(\d+)\s+[\¥\\]?(\d[\d,]+)\s+[\¥\\]?(\d[\d,]+)/;
      const match = line.match(itemPattern);

      if (match) {
        const item: ReceiptItem = {
          name: match[1].trim(),
          quantity: parseInt(match[2], 10),
          unitPrice: parseInt(match[3].replace(/,/g, ""), 10),
          totalPrice: parseInt(match[4].replace(/,/g, ""), 10),
        };
        items.push(item);
      }
    }

    return items;
  }

  // 店舗名からカテゴリを推測
  private categorizeStore(storeName: string): string {
    const lowerStoreName = storeName.toLowerCase();

    if (
      /restaurant|cafe|coffee|レストラン|カフェ|食堂|居酒屋|ダイニング/.test(
        lowerStoreName
      )
    ) {
      return "飲食";
    } else if (
      /market|super|コンビニ|マート|スーパー|ストア/.test(lowerStoreName)
    ) {
      return "食料品";
    } else if (/gas|petrol|ガソリン|スタンド|石油/.test(lowerStoreName)) {
      return "交通費";
    } else if (/hotel|ホテル|旅館|inn/.test(lowerStoreName)) {
      return "宿泊";
    } else if (/stationery|book|文房具|本|書店/.test(lowerStoreName)) {
      return "文具・書籍";
    } else if (/pharma|drug|医薬|薬局|ドラッグ/.test(lowerStoreName)) {
      return "医療・健康";
    }

    return "その他";
  }

  // テキストから領収書データを解析
  private parseReceiptText(text: string, filePath: string): Receipt {
    // テキストの後処理
    const processedText = this.postprocessText(text);

    // 各フィールドをプロンプトを使用して抽出
    const extractedFields: any = {};
    for (const prompt of japaneseReceiptPrompts) {
      extractedFields[prompt.fieldName] = this.extractFieldWithPrompt(
        processedText,
        prompt
      );
    }

    // 商品アイテムを抽出
    const items = this.extractItems(processedText);

    return {
      id: path.basename(filePath, path.extname(filePath)),
      storeName: extractedFields.storeName || "不明な店舗",
      date: extractedFields.date || "日付不明",
      amount: extractedFields.amount || 0,
      items: items,
      taxAmount: extractedFields.taxAmount,
      paymentMethod: extractedFields.paymentMethod,
      rawText: processedText,
      category: this.categorizeStore(extractedFields.storeName || ""),
    };
  }

  // 画像から領収書データを解析
  async parseReceiptImage(imagePath: string): Promise<Receipt> {
    try {
      // 画像ファイルを読み込む
      const imageBuffer = fs.readFileSync(imagePath);

      // 画像を前処理
      const processedBuffer = await this.preprocessImage(imageBuffer);

      // Vision APIを使用してテキスト検出を実行
      const [result] = await this.client.textDetection({
        image: { content: processedBuffer },
        imageContext: {
          languageHints: ["ja"], // 日本語を指定
        },
      });

      const detections = result.textAnnotations;
      if (!detections || detections.length === 0) {
        throw new Error("テキストが検出されませんでした");
      }

      // 検出されたテキスト
      const text = detections[0].description || "";

      // テキストから領収書データを抽出
      return this.parseReceiptText(text, imagePath);
    } catch (error) {
      console.error("領収書解析エラー:", error);
      throw error;
    }
  }

  // ディレクトリ内の全ての画像を処理
  async processDirectory(directoryPath: string): Promise<Receipt[]> {
    const receipts: Receipt[] = [];

    // ディレクトリが存在するか確認
    if (!fs.existsSync(directoryPath)) {
      throw new Error(`ディレクトリが見つかりません: ${directoryPath}`);
    }

    // ディレクトリ内のファイルを取得
    const files = fs.readdirSync(directoryPath);

    // 画像ファイルをフィルタリング
    const imageFiles = files.filter((file) => {
      const ext = path.extname(file).toLowerCase();
      return [".jpg", ".jpeg", ".png", ".gif", ".bmp"].includes(ext);
    });

    console.log(`${imageFiles.length}件の画像ファイルを処理します...`);

    // 各画像ファイルを処理
    for (const file of imageFiles) {
      const imagePath = path.join(directoryPath, file);
      try {
        console.log(`処理中: ${file}`);
        const receipt = await this.parseReceiptImage(imagePath);
        receipts.push(receipt);
        console.log(
          `  解析成功: ${receipt.storeName}, ${receipt.amount}円, ${receipt.date}`
        );
      } catch (error) {
        console.error(`  処理失敗: ${file}`, error);
      }
    }

    return receipts;
  }

  // JSON形式で保存
  saveAsJson(receipts: Receipt[], outputPath: string): void {
    fs.writeFileSync(outputPath, JSON.stringify(receipts, null, 2), "utf8");
    console.log(`JSONファイルを出力しました: ${outputPath}`);
  }

  // CSV形式で保存
  async saveAsCsv(receipts: Receipt[], outputPath: string): Promise<void> {
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

  // 会計ソフト用CSV形式で保存
  async saveAsAccountingCsv(
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
  private mapCategoryToAccount(category: string): string {
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

// コマンドライン引数を解析する関数
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    directoryPath: "./receipts",
    outputPath: "./output/receipts_data",
    format: "json" as "json" | "csv" | "accounting",
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" || args[i] === "-d") {
      result.directoryPath = args[++i];
    } else if (args[i] === "--output" || args[i] === "-o") {
      result.outputPath = args[++i];
    } else if (args[i] === "--format" || args[i] === "-f") {
      const format = args[++i];
      if (format === "json" || format === "csv" || format === "accounting") {
        result.format = format;
      }
    }
  }

  return result;
}

// 実行用の関数
async function main() {
  try {
    // コマンドライン引数を解析
    const args = parseArgs();

    // 出力ディレクトリが存在することを確認
    const outputDir = path.dirname(args.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 領収書解析クラスのインスタンスを作成
    const analyzer = new ReceiptAnalyzer();

    console.log(`ディレクトリの処理を開始: ${args.directoryPath}`);

    // ディレクトリ内の全ての領収書画像を処理
    const receipts = await analyzer.processDirectory(args.directoryPath);

    // 結果を出力
    if (receipts.length > 0) {
      if (args.format === "json") {
        analyzer.saveAsJson(receipts, `${args.outputPath}.json`);
      } else if (args.format === "csv") {
        await analyzer.saveAsCsv(receipts, `${args.outputPath}.csv`);
      } else if (args.format === "accounting") {
        await analyzer.saveAsAccountingCsv(receipts, `${args.outputPath}.csv`);
      }

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
