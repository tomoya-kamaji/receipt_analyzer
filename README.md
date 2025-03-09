# 領収書解析ツール (Receipt Analyzer)

領収書画像からテキストを抽出し、構造化データとして出力するツールです。Google Cloud Vision APIを使用してOCR処理を行い、日本語の領収書から店舗名、日付、金額、消費税などの情報を自動抽出します。

## 前提条件

- [Bun](https://bun.sh/) がインストールされていること
- Google Cloud Vision API のアクセス権限があること
- Google Cloud の認証情報が設定されていること

## インストール

```bash
# リポジトリをクローン
git clone https://github.com/yourusername/receipt-analyzer.git
cd receipt-analyzer

# 依存パッケージをインストール
bun install
```

## 環境設定

1. `.env` ファイルを作成し、Google Cloud の認証情報を設定します：

```
GOOGLE_APPLICATION_CREDENTIALS=./path/to/your-service-account-key.json
```

2. Google Cloud Vision API を有効にしてサービスアカウントキーを取得していない場合は、以下の手順で取得してください：
   - [Google Cloud Console](https://console.cloud.google.com/) にアクセス
   - プロジェクトを作成または選択
   - Vision API を有効化
   - サービスアカウント作成とキーのダウンロード

## 使い方

### 基本的な使い方

```bash
bun run index.ts --dir ./receipts
```

### オプション

- `--dir`, `-d`: 領収書画像が格納されているディレクトリのパス（デフォルト: `./receipts`）

## 仕組み

1. 指定されたディレクトリから画像ファイル（jpg, jpeg, png, gif, bmp）を検索
2. 各画像に対して前処理（回転、グレースケール化、コントラスト正規化、シャープ化）
3. Google Cloud Vision API を使用して OCR 処理
4. 指定された形式でデータを出力(/output)
