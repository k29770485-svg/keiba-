# netkeiba の実仕様（実アクセスで検証済み）


`scripts/verify_netkeiba_contract.mjs` を走らせれば、以下が現在も成立するか自動確認できる。
パーサを書く前と、取得結果が不自然に NULL になったときに実行する。

## エンコーディング

| 対象 | 文字コード | 備考 |
|---|---|---|
| 馬個体ページ `/horse/{id}/` | **EUC-JP** | UTF-8 で読むと馬名が化け、名前照合が常に失敗する |
| レース結果ページ `/race/{id}/` | **EUC-JP** | 同上 |
| Ajax エンドポイント | **UTF-8** | `input=UTF-8&output=json` を付けて呼ぶ |

## 静的HTMLから取れるもの

```
<div class="horse_title">
  <h1>イクイノックス</h1>              ← 馬名。照合の基準にする
  <p class="txt_01">抹消　牡　青鹿毛</p>  ← 全角スペース区切り
  <p class="eng_name"><a>EQUINOX</a></p>
</div>
<table class="db_prof_table"> ... </table>  ← 生年月日/調教師/馬主/生産者/通算成績
```

**性別・毛色は必ずトークン分割で判定する。** `/(牡|牝|セ)/` の素朴なマッチは
「抹消」等を含む文字列全体から最初の1文字を拾うため、無関係な文字を性別と誤認する。

```js
const tokens = text.split(/[\s\u3000]+/).filter(Boolean);
const sex = tokens.find(t => t === "牡" || t === "牝" || t === "セ");
```

**馬主セルは `<a>` の前にカラーシルク画像が入る。** `<a>` が無い未登録馬主では
タグ除去後が空になるので、`img[alt]` をフォールバックにする。

```html
<td><img alt="キーファーズ" class="OwnerColours"><a href="/owner/002803/">キーファーズ</a></td>
```

**調教師の `(栗東)` `(美浦)` は `<a>` の外にある。** 関東馬/関西馬の判別に使えるので
`<a>` テキストだけを採らず、セル全体から括弧内も抽出する。

## 静的HTMLから取れないもの（Ajax 後読み）

これが「血統と画像が永久に NULL」の主因。静的HTMLに `blood_table` は**存在しない**。

```
血統: https://db.netkeiba.com/horse/ajax_horse_pedigree.html?input=UTF-8&output=json&id={id}
画像: https://db.netkeiba.com/horse/ajax_photo_paddock.html?input=UTF-8&output=json&block_name=horse_photo_paddock_top&id={id}

→ {"status":"OK","data":"<table class=\"blood_table\">..."}
```

血統表は3代分のグリッド。**1行目先頭セルが父、`class` に `b_fml` を含み `rowspan=2` のセルが母、その右隣が母父。**

画像レスポンスには**遅延読み込み用に `id=` が空のプレースホルダが混在する。**
空 id を拾うと `...batai_img.php?id=` という壊れたURLが保存される。
**id が数値のURLのみを採用する。**

```js
const candidates = data.match(/https:\/\/[\w.-]*netkeiba\.com\/[^"'\s]*batai_img\.php\?id=\d+/g);
```

## リダイレクトの解決

`Location` は相対パスで返ることがある。**文字列連結ではなく `new URL(location, base)` で解決する。**
誤って組み立てると別馬のページに到達し、名前照合が無ければそのまま別馬のデータを書き込む。

## レート制限の挙動

短時間に多数のリクエストを送ると、**HTTPステータスを返す前に TLS ハンドシェイク段階で切断される。**

```
Client network socket disconnected before secure TLS connection was established
ECONNRESET / EPIPE / ETIMEDOUT / socket hang up
```

この形は「データが存在しない」ではなく「レート制限」を意味する。
`not_found` として扱うと、実在する馬を恒久的に取得対象外にしてしまう。
**区別して指数バックオフで再試行し、それでも駄目なら `rate_limited` として記録し後で再開する。**

リクエスト間隔は 1500〜2000ms を目安にする。1頭の詳細取得で 3 リクエスト
（個体ページ + 血統 Ajax + 画像 Ajax）を消費する。

## レース結果ページからの ID 逆引き

アンカーは 2 系統あり、**片方だけ見ると取りこぼす。**

```html
<a href="/horse/2019105219/">イクイノックス</a>                  <!-- A: テキストが馬名 -->
<a href="/horse/2017101835/" title="コントレイル" class="x"></a>  <!-- B: title が馬名 -->
```

HTTP 200 なのに 0 頭しか取れない場合は、ページ構造の変化を疑うべき**異常**として扱う
（黙って 0 件成功にすると、壊れていることに気付けない）。

## 検証済みレースURL

1リクエストで最大18頭のIDが得られる。近年のGIから選ぶとよい。

| レース | URL |
|---|---|
| 2023 ジャパンカップ | `https://db.netkeiba.com/race/202305050812/` |
| 2023 有馬記念 | `https://db.netkeiba.com/race/202306050811/` |
| 2022 有馬記念 | `https://db.netkeiba.com/race/202206050811/` |
| 2021 ジャパンカップ | `https://db.netkeiba.com/race/202105050812/` |
| 2020 有馬記念 | `https://db.netkeiba.com/race/202006050811/` |
| 2023 フェブラリーS | `https://db.netkeiba.com/race/202305010811/` |
| 2022 皐月賞 | `https://db.netkeiba.com/race/202206030811/` |
| 2022 マイルCS | `https://db.netkeiba.com/race/202209050811/` |
| 2021 チャンピオンズC | `https://db.netkeiba.com/race/202107060211/` |
| 2020 桜花賞 | `https://db.netkeiba.com/race/202009020611/` |

レースIDは `{年}{場コード}{回}{日}{R}` 形式だが**推測で組み立てると存在しないページに当たる。**
新しいレースを追加する際は `verify_netkeiba_contract.mjs` に URL を渡して出走馬が取れるか確認する。

## 馬名検索は使わない

`db.netkeiba.com/?pid=horse_search` 系の馬名検索は EUC-JP でのクエリ送信が必要で不安定。
**ID の解決はレース結果ページからの逆引きを第一選択にする。**

## 出典表示

取得データを表示する成果物には、netkeiba を出典として明記する。
画像は直リンクせず、Referer を付けたサーバー側プロキシ経由で表示する
（`templates/imageProxy.ts` 参照）。
