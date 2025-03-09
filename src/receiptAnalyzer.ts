import { ImageAnnotatorClient } from "@google-cloud/vision";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

// 領収書のデータ構造を定義
interface Receipt {
  id: string;
  text: string; // rawTextのみを保持するように単純化
}

export class ReceiptAnalyzer {
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

      return {
        id: path.basename(imagePath, path.extname(imagePath)),
        text: text,
      };
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
        console.log(`  解析成功: ${receipt.id}`);
      } catch (error) {
        console.error(`  処理失敗: ${file}`, error);
      }
    }

    return receipts;
  }

  // 改行を削除したシンプルなCSV形式の出力
  saveSimpleCsv(receipts: Receipt[], outputPath: string): void {
    let csvContent = "id,text\n";

    receipts.forEach((receipt) => {
      // 改行を半角スペースに置換し、連続する空白を単一のスペースにまとめる
      const cleanedText = receipt.text
        .replace(/\n/g, " ") // 改行を半角スペースに変換
        .replace(/\r/g, "") // キャリッジリターンを削除
        .replace(/\s+/g, " ") // 連続する空白を1つにまとめる
        .trim(); // 前後の余分な空白を削除

      // CSVエスケープ処理（ダブルクォートの処理）
      const escapedText = cleanedText.replace(/"/g, '""');
      csvContent += `${receipt.id},"${escapedText}"\n`;
    });

    fs.writeFileSync(outputPath, csvContent, "utf8");
    console.log(`シンプルCSVファイルを出力しました: ${outputPath}`);
  }
}
