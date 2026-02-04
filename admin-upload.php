<?php
// --- 設定：自分だけがアクセスできるようにパスワードを決めてください ---
$admin_pass = "ara-tech-admin"; // ここを好きなパスワードに変えてください

if ($_POST['pass'] === $admin_pass) {
    // 入力データの取得
    $artist = htmlspecialchars($_POST['artist']);
    $date = htmlspecialchars($_POST['date']);
    $venue = htmlspecialchars($_POST['venue']);
    $dl_url = $_POST['dl_url'];
    $flyer_url = $_POST['flyer_url'];
    $filename = "dl_" . date("Ymd") . "_" . $_POST['artist_id'] . ".html";

    // テンプレートHTMLの組み立て（デザインを維持）
    $html = <<<EOD
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>{$artist} REC DATA | ARA-TECH</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        :root { --primary-blue: #007bff; }
        body { background-color: #f8f9fa; font-family: sans-serif; }
        .navbar { background-color: var(--primary-blue) !important; padding: 10px 0; }
        .dl-header { background: #1a1a1a; color: white; padding: 60px 0 100px; text-align: center; }
        .dl-card { background: white; border-radius: 20px; box-shadow: 0 15px 35px rgba(0,0,0,0.1); margin-top: -50px; padding: 40px; }
        .btn-download { background: var(--primary-blue); color: white; padding: 15px; display: block; text-align: center; border-radius: 5px; font-weight: bold; text-decoration: none; }
    </style>
</head>
<body>
    <nav class="navbar navbar-dark"><div class="container"><a class="navbar-brand" href="./">ARA-TECH</a></div></nav>
    <header class="dl-header"><h1>REC DATA DOWNLOAD</h1></header>
    <main class="container mb-5">
        <div class="row justify-content-center">
            <div class="col-lg-8 dl-card">
                <div class="row">
                    <div class="col-md-5"><img src="{$flyer_url}" class="img-fluid rounded"></div>
                    <div class="col-md-7">
                        <h2 class="fw-bold">{$artist}</h2>
                        <p class="text-muted">{$date} @ {$venue}</p>
                        <hr>
                        <a href="{$dl_url}" class="btn-download">DOWNLOAD (REC DATA)</a>
                        <p class="small text-danger mt-3">※期限：14日間 / Wi-Fi推奨</p>
                    </div>
                </div>
            </div>
        </div>
    </main>
</body>
</html>
EOD;

    // ファイル保存
    file_put_contents($filename, $html);
    echo "ページが完成しました！ URL: <a href='./$filename'>./$filename</a>";
    exit;
}
?>

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>ARA-TECH ページ生成管理画面</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="p-5">
    <div class="container" style="max-width: 600px;">
        <h2 class="mb-4">ダウンロードページ自動作成</h2>
        <form method="post">
            <div class="mb-3">管理用パスワード: <input type="password" name="pass" class="form-control" required></div>
            <hr>
            <div class="mb-3">アーティスト名: <input type="text" name="artist" class="form-control" placeholder="〇〇バンド" required></div>
            <div class="mb-3">英数字ID (URL用): <input type="text" name="artist_id" class="form-control" placeholder="artist01" required></div>
            <div class="mb-3">公演日: <input type="text" name="date" class="form-control" placeholder="2026.02.04"></div>
            <div class="mb-3">会場: <input type="text" name="venue" class="form-control" placeholder="広島クラブクアトロ"></div>
            <div class="mb-3">フライヤー画像URL: <input type="text" name="flyer_url" class="form-control" placeholder="img/flyer.jpg"></div>
            <div class="mb-3">RECデータURL (GoogleDrive等): <input type="text" name="dl_url" class="form-control" required></div>
            <button type="submit" class="btn btn-primary w-100">ページを作成する</button>
        </form>
    </div>
</body>
</html>