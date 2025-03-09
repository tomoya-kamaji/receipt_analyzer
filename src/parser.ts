// src/parser.ts
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { readFileSync, writeFileSync } from "fs";
import * as path from "path";

// 領収書のデータ構造
export interface Receipt {
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

export interface ReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export class VisionReceiptParser {
  private client: ImageAnnotatorClient;

  constructor() {
    this.client = new ImageAnnotatorClient();
  }

  async parseReceiptImage(imagePath: string): Promise<Receipt> {
    try {
      // 画像ファイルを読み込む
      const imageBuffer = readFileSync(imagePath);

      // Vision APIを使用してテキスト検出を実行
      const [result] = await this.client.textDetection(imageBuffer);
      const detections = result.textAnnotations;

      if (!detections || detections.length === 0) {
        throw new Error("テキストが検出されませんでした");
      }

      // 検出されたテキスト
      const text = detections[0].description || "";

      // テキストから領収書データを抽出
      return this.parseReceiptText(text, imagePath);
    } catch (error) {
      console.error("Vision API解析エラー:", error);
      throw error;
    }
  }

  private parseReceiptText(text: string, filePath: string): Receipt {
    // 店名を抽出
    const storeName = this.extractStoreName(text);

    // 日付を抽出
    const date = this.extractDate(text);

    // 金額を抽出
    const amount = this.extractAmount(text);

    // 商品アイテムを抽出
    const items = this.extractItems(text);

    // 税額を抽出
    const taxAmount = this.extractTaxAmount(text);

    // 支払い方法を抽出
    const paymentMethod = this.extractPaymentMethod(text);

    return {
      id: path.basename(filePath, path.extname(filePath)),
      storeName,
      date,
      amount,
      items,
      taxAmount,
      paymentMethod,
      rawText: text,
      category: this.categorizeStore(storeName),
    };
  }

  // 店名抽出
  private extractStoreName(text: string): string {
    const storeNamePatterns = [
      /店名[:|：]\s*(.+)/i,
      /(.+)\s*\n.*領収/i,
      /(.+)\s*\n.*[0-9]{3}-[0-9]{4}/i,
    ];

    for (const pattern of storeNamePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length > 0) {
      return lines[0].trim();
    }

    return "不明な店舗";
  }

  // 日付抽出
  private extractDate(text: string): string {
    const datePatterns = [
      /(\d{4})[年/\-.](\d{1,2})[月/\-.](\d{1,2})/,
      /(\d{2,4})\/(\d{1,2})\/(\d{1,2})/,
      /(\d{1,2})月(\d{1,2})日/,
    ];

    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        if (match.length === 4) {
          let year = match[1];
          if (year.length === 2) {
            year = `20${year}`;
          }
          return `${year}-${match[2].padStart(2, "0")}-${match[3].padStart(
            2,
            "0"
          )}`;
        } else if (match.length === 3) {
          const currentYear = new Date().getFullYear();
          return `${currentYear}-${match[1].padStart(
            2,
            "0"
          )}-${match[2].padStart(2, "0")}`;
        }
      }
    }

    return "日付不明";
  }

  // 金額抽出
  private extractAmount(text: string): number {
    const amountPatterns = [
      /合計[金額]*[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /(?:小計|お買上げ|計).?[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /(?:total|金額).?[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /[\¥\\](\d[\d,]+)/,
    ];

    for (const pattern of amountPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return parseInt(match[1].replace(/,/g, ""), 10);
      }
    }

    const numbers = text.match(/\d[\d,]+/g);
    if (numbers && numbers.length > 0) {
      const parsedNumbers = numbers.map((num) =>
        parseInt(num.replace(/,/g, ""), 10)
      );
      return Math.max(...parsedNumbers);
    }

    return 0;
  }

  // 商品アイテム抽出
  private extractItems(text: string): ReceiptItem[] {
    const items: ReceiptItem[] = [];

    const lines = text.split("\n");
    for (const line of lines) {
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

  // 税額抽出
  private extractTaxAmount(text: string): number | undefined {
    const taxPatterns = [
      /消費税[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /内税[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /外税[\s:：]*[\¥\\]?(\d[\d,]+)/i,
      /税額[\s:：]*[\¥\\]?(\d[\d,]+)/i,
    ];

    for (const pattern of taxPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return parseInt(match[1].replace(/,/g, ""), 10);
      }
    }

    return undefined;
  }

  // 支払い方法抽出
  private extractPaymentMethod(text: string): string | undefined {
    const paymentPatterns = [
      /支払[方法い][\s:：]*(.+)/i,
      /お支払[\s:：]*(.+)/i,
      /(クレジット|カード|現金|電子マネー|QRコード|PayPay|メルペイ)/i,
    ];

    for (const pattern of paymentPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return undefined;
  }

  // カテゴリ分類
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
    }

    return "その他";
  }
}
