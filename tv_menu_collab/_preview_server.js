const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(__dirname, "_tv_menu_snapshot.html"), "utf8");
const logo = path.join(root, "src", "assets", "tulipi-logo.jpg");

const sampleMenu = {
  marka: "TULIPI",
  guncelleme: "2026-06-30T12:00:00",
  imza: { ad: "Cookie Latte", aciklama: "Kadife sut kopugu · karamel finish", fiyat: 205 },
  pair: { ad: "San Sebastian", fiyat: 195, mesaj: "Latte ile kusursuz eslik" },
  kategoriler: [
    {
      kategori: "Classic Coffees",
      alt: "",
      urunler: [
        { ad: "Espresso", aciklama: "single origin", f8: 110, f14: null, fice: null },
        { ad: "Double Espresso", aciklama: "", f8: 120, f14: null, fice: null },
        { ad: "Americano", aciklama: "", f8: 135, f14: 145, fice: 155 },
        { ad: "Latte", aciklama: "silky smooth", f8: 170, f14: 180, fice: 195 },
        { ad: "Cappuccino", aciklama: "velvet foam", f8: 170, f14: 180, fice: 195 },
        { ad: "Flat White", aciklama: "", f8: null, f14: 185, fice: 195 },
        { ad: "Mocha", aciklama: "70% cacao", f8: 185, f14: 200, fice: 205 },
        { ad: "Filtre Kahve", aciklama: "", f8: 135, f14: 145, fice: 155 },
      ],
    },
    {
      kategori: "Signature Coffees",
      alt: "",
      urunler: [
        { ad: "Cookie Latte", aciklama: "", f8: 190, f14: 205, fice: 215 },
        { ad: "Pumpkin Latte", aciklama: "", f8: 190, f14: 205, fice: 215 },
        { ad: "Dream Latte", aciklama: "", f8: 190, f14: 205, fice: 215 },
        { ad: "Banana Fish", aciklama: "", f8: 190, f14: 205, fice: 215 },
        { ad: "Berry Latte", aciklama: "", f8: 190, f14: 205, fice: 215 },
        { ad: "Vanilla Latte", aciklama: "", f8: 190, f14: 205, fice: 215 },
        { ad: "Madagaskar Latte", aciklama: "", f8: 190, f14: 205, fice: 215 },
        { ad: "Velvet Latte", aciklama: "", f8: 190, f14: 205, fice: 215 },
      ],
    },
    {
      kategori: "Iced & Cold",
      alt: "",
      urunler: [
        { ad: "Iced Latte", aciklama: "over ice", f8: 180, f14: null, fice: null },
        { ad: "Iced Americano", aciklama: "", f8: 155, f14: null, fice: null },
        { ad: "Iced Mocha", aciklama: "", f8: 205, f14: null, fice: null },
        { ad: "Cold Brew", aciklama: "18h steeped", f8: 175, f14: null, fice: null },
      ],
    },
    {
      kategori: "Mocktails",
      alt: "",
      urunler: [
        { ad: "YODA", aciklama: "", f8: null, f14: null, fice: 220 },
        { ad: "Fetish", aciklama: "", f8: null, f14: null, fice: 220 },
        { ad: "Serotonin", aciklama: "", f8: null, f14: null, fice: 220 },
        { ad: "Pink Floyd", aciklama: "", f8: null, f14: null, fice: 220 },
      ],
    },
    {
      kategori: "Milkshakes",
      alt: "",
      urunler: [
        { ad: "Cikolata Milkshake", aciklama: "", f8: null, f14: null, fice: 210 },
        { ad: "Cilek Milkshake", aciklama: "", f8: null, f14: null, fice: 210 },
        { ad: "Muz Milkshake", aciklama: "", f8: null, f14: null, fice: 210 },
      ],
    },
    {
      kategori: "Desserts",
      alt: "",
      urunler: [
        { ad: "San Sebastian", aciklama: "burnt basque", f8: 195, f14: null, fice: null },
        { ad: "Profiterol", aciklama: "", f8: 185, f14: null, fice: null },
        { ad: "Cookie", aciklama: "", f8: 95, f14: null, fice: null },
      ],
    },
  ],
};

const sampleSignals = {
  saat_modu: { mod: "ogle", etiket: "SERINLE", oneri: "Iced Drinks" },
  mevsim: { ad: "yaz", etiket: "YAZ", oneri: "Cold Brew · Iced Latte" },
  ozel: { etiket: "SUMMER", mesaj: "Yeni sezon lezzetleri" },
  en_cok: "Cookie Latte",
  yeni: ["Frozen Berry", "Serotonin"],
  happy_hour: { aktif: true, bas: 14, bit: 16, mesaj: "2. icecek icin tatli indirimi" },
  top3: [
    { ad: "Cookie Latte", adet: 42 },
    { ad: "Latte", adet: 31 },
    { ad: "Iced Americano", adet: 24 },
  ],
  oneri: { ad: "Velvet Latte", fiyat: 205, kategori: "Signature Coffees", neden: "Bugun kesfet" },
  seritler: [
    "YAZ · Cold Brew · Iced Latte",
    "BUGUN EN COK · Cookie Latte",
    "HAPPY HOUR · 14:00-16:00",
  ],
};

function sendJson(res, body) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function streamFile(res, filePath, type) {
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  res.writeHead(200, { "Content-Type": type });
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/triple") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><html><body style="margin:0;background:#120d09;display:grid;grid-template-columns:repeat(3,1fr);height:100vh;overflow:hidden"><iframe src="/?ekran=1" style="border:0;width:100%;height:100%"></iframe><iframe src="/?ekran=2" style="border:0;width:100%;height:100%"></iframe><iframe src="/?ekran=3" style="border:0;width:100%;height:100%"></iframe></body></html>'
    );
    return;
  }

  if (url.pathname === "/api/tv-menu") return sendJson(res, sampleMenu);
  if (url.pathname === "/api/tv-signals") return sendJson(res, sampleSignals);
  if (url.pathname === "/api/tv-gosterim") return sendJson(res, { success: true });
  if (url.pathname === "/tv-menu/logo") return streamFile(res, logo, "image/jpeg");

  if (url.pathname.startsWith("/tv-menu/cup/")) {
    const name = url.pathname.split("/").pop();
    return streamFile(res, path.join(root, "public", "tv", `cup_${name}.jpeg`), "image/jpeg");
  }

  if (url.pathname.startsWith("/tv-menu/clip/")) {
    const name = url.pathname.split("/").pop();
    return streamFile(res, path.join(root, "public", "tv", `${name}.mp4`), "video/mp4");
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const port = Number(process.env.TV_PREVIEW_PORT || 4123);
server.listen(port, "127.0.0.1", () => {
  console.log(`tv-menu preview server listening on http://127.0.0.1:${port}`);
});
