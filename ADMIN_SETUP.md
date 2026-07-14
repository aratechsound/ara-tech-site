# WORKS管理画面の初期設定

この一度だけの設定が終われば、以後は `https://ara-tech.cc/admin.html` にログインして、フライヤーと紹介文を登録するだけでWORKSページを更新できます。

## 1. Supabaseプロジェクトを作る

1. [Supabase](https://supabase.com/)でアカウントを作成し、新しいプロジェクトを作成します。
2. Dashboardの **Authentication > Users** で、管理用のメールアドレスとパスワードのユーザーを1名作成します。
3. Dashboardの **SQL Editor** で `supabase/schema.sql` の内容を実行します。
4. 同じSQL Editorで `supabase/bootstrap-admin.sql` のメールアドレスを置き換えて実行します。

## 2. サイトをSupabaseへ接続する

Dashboardの **Project Settings > API** から、次の2つをコピーします。

- Project URL
- Publishable key（または anon key）

`js/supabase-config.js` に貼り付けます。ここへ **service_role key** を貼り付けることは絶対にしないでください。

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-PUBLISHABLE-OR-ANON-KEY';
```

この変更をGitHubへ送ると管理画面が有効になります。

## 3. 投稿する

`/admin.html` にアクセスして管理者アカウントでログインします。イベント名、開催日、会場、紹介文、フライヤー画像を入れ、公開状態で保存するとWORKSの「最新の現場」に表示されます。

## 将来スタッフを増やす場合

Supabaseでスタッフのログインアカウントを作り、そのメールアドレスを使って `bootstrap-admin.sql` と同じ形式で `work_admins` に追加します。サイトのコードを変更する必要はありません。
