// index.js
const express = require("express");
const fs = require("fs");
const axios = require("axios");
const path = require("path");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2", 10);

let browserPromise = null;
let executablePathCache = null;

/* ===================== UTILS / LOGS ===================== */
function logChromiumBinPresence() {
  try {
    const pkgRoot = path.dirname(require.resolve("@sparticuz/chromium/package.json"));
    const binDir = path.join(pkgRoot, "bin");
    console.log("[chromium] bin exists?", fs.existsSync(binDir), "at:", binDir);
  } catch (e) {
    console.log("[chromium] cannot resolve package root:", e.message);
  }
}

/* ===================== WARMUP CHROMIUM ===================== */
async function prewarmChromium() {
  logChromiumBinPresence();
  executablePathCache = await chromium.executablePath();
  if (!executablePathCache) throw new Error("chromium.executablePath() retornou vazio");
  console.log("[chromium] executablePath:", executablePathCache);
}

/* ===================== LAUNCHER PUPPETEER ===================== */
async function getBrowser() {
  if (!browserPromise) {
    const pathToExe = executablePathCache || (await chromium.executablePath());

    browserPromise = puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        // ATENÇÃO: não usar --single-process (causa travas/parciais)
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: pathToExe,
      headless: chromium.headless, // usa o modo correto do Sparticuz
      ignoreHTTPSErrors: true,
      env: { ...process.env, TZ: "America/Sao_Paulo" },
    });
  }
  return browserPromise;
}

/* ===================== SEMÁFORO (CONCORRÊNCIA) ===================== */
let inFlight = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (inFlight < MAX_CONCURRENT) {
        inFlight++;
        resolve(() => {
          inFlight--;
          const next = queue.shift();
          if (next) next();
        });
      } else {
        queue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

/* ===================== APP ===================== */
const app = express();

app.get("/gerar-pdf", async (req, res) => {
  // evita o Railway/NGINX matar a conexão cedo
  req.setTimeout(120000);

  const cnpj = (req.query.cnpj || "").replace(/\D/g, "");
  if (!cnpj) {
    return res.status(400).send("❌ Informe um CNPJ na URL, ex: /gerar-pdf?cnpj=04486026000142");
  }

  const release = await acquire();
  let page;

  try {
    /* 1) BrasilAPI */
    const { data } = await axios.get(
      `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
      { timeout: 20000 }
    );

    const razao = data?.razao_social || "Não encontrado";
    let fantasia = (data?.nome_fantasia || "").trim();
    if (!fantasia || fantasia.toLowerCase() === "não encontrado") fantasia = razao;

    /* 2) Data/Hora SP (server-side) */
    const formatter = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const dataHora = `${formatter.format(new Date())} (Horário SP)`;

    /* 3) Template */
    const templatePath = path.join(process.cwd(), "template.html");
    if (!fs.existsSync(templatePath)) {
      throw new Error(`template.html não encontrado em ${templatePath}`);
    }

    const htmlTemplate = fs.readFileSync(templatePath, "utf8");
    const html = htmlTemplate
      .replace(/{{CNPJ}}/g, cnpj)
      .replace(/{{RAZAO}}/g, razao)
      .replace(/{{FANTASIA}}/g, fantasia)
      .replace(/{{DATA_HORA}}/g, dataHora);

    /* 4) Render */
    const browser = await getBrowser();
    page = await browser.newPage();

    // melhora fidelidade visual (usa CSS de tela)
    await page.emulateMediaType("screen");
    try { await page.emulateTimezone("America/Sao_Paulo"); } catch {}

    // carrega e espera fontes/CSS externos (Google Fonts, etc.)
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
      timeout: 0, // não aborta PDF em páginas pesadas
    });

    // sanity check: evita enviar PDF minúsculo (provável corrompido)
    if (!pdfBuffer || pdfBuffer.length < 1024) {
      console.error("⚠️ PDF muito pequeno:", pdfBuffer?.length);
      throw new Error("PDF gerado com tamanho inesperado");
    }

    /* 5) Resposta */
    const safeRazao = String(razao).replace(/[\\/:*?"<>|]/g, "");
    const fileName = `Proposta Comercial PagBank - ${safeRazao}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    // NÃO definir Content-Length manualmente: proxies podem comprimir/alterar tamanho
    res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ Erro ao gerar PDF:", err?.response?.data || err.message);
    res.status(500).send("Erro ao gerar o PDF.");
  } finally {
    if (page) {
      try { await page.close({ runBeforeUnload: true }); } catch {}
    }
    release();
  }
});

app.get("/health", (_req, res) => res.send("ok"));

/* ===================== START ===================== */
prewarmChromium()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 http://localhost:${PORT}/gerar-pdf?cnpj=04486026000142`);
    });
  })
  .catch((e) => {
    console.error("❌ Falha ao preparar Chromium:", e);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  if (browserPromise) {
    try { (await browserPromise).close(); } catch {}
  }
  process.exit(0);
});
