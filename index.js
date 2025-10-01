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

/* ============ LOG / WARMUP ============ */
function logChromiumBinPresence() {
  try {
    const pkgRoot = path.dirname(require.resolve("@sparticuz/chromium/package.json"));
    const binDir = path.join(pkgRoot, "bin");
    console.log("[chromium] bin exists?", fs.existsSync(binDir), "at:", binDir);
  } catch (e) {
    console.log("[chromium] cannot resolve package root:", e.message);
  }
}

async function prewarmChromium() {
  logChromiumBinPresence();
  executablePathCache = await chromium.executablePath();
  if (!executablePathCache) throw new Error("chromium.executablePath() retornou vazio");
  console.log("[chromium] executablePath:", executablePathCache);
}

/* ============ LAUNCHER ============ */
async function getBrowser() {
  if (!browserPromise) {
    const pathToExe = executablePathCache || (await chromium.executablePath());
    browserPromise = puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        // NÃO usar --single-process
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: pathToExe,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
      env: { ...process.env, TZ: "America/Sao_Paulo" },
    });
  }
  return browserPromise;
}

/* ============ SEMÁFORO ============ */
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

/* ============ APP ============ */
const app = express();

/**
 * ROTA DE TESTE: PDF mínimo inline (sem rede)
 * Use para validar que o envio/headers/Chromium estão OK.
 * Acesse: /pdf-test
 */
app.get("/pdf-test", async (_req, res) => {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.emulateMediaType("screen");
    await page.setContent(
      `
      <html><head><meta charset="utf-8">
      <style>@page{size:A4;margin:12mm}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>
      </head>
      <body style="font-family: system-ui, Arial; padding:20px">
        <h1>PDF Teste ✅</h1>
        <p>Ação, informação, coração 💚 — ${new Date().toISOString()}</p>
      </body></html>
      `,
      { waitUntil: "domcontentloaded", timeout: 20000 }
    );
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });

    console.log("[/pdf-test] bytes:", pdfBuffer.length);
    try { fs.writeFileSync("/tmp/last.pdf", pdfBuffer); } catch {}

    if (!pdfBuffer || pdfBuffer.length < 1024) {
      return res.status(500).send("PDF muito pequeno no /pdf-test");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="teste.pdf"`);
    return res.end(pdfBuffer);
  } catch (e) {
    console.error("[/pdf-test] erro:", e.message);
    return res.status(500).send("Erro no /pdf-test");
  } finally {
    if (page) { try { await page.close({ runBeforeUnload: true }); } catch {} }
  }
});

/**
 * ROTA PRINCIPAL: usa seu template + BrasilAPI
 * Exemplo: /gerar-pdf?cnpj=04486026000142
 */
app.get("/gerar-pdf", async (req, res) => {
  req.setTimeout(120000);

  const cnpj = (req.query.cnpj || "").replace(/\D/g, "");
  if (!cnpj) {
    return res.status(400).send("❌ Informe um CNPJ na URL, ex: /gerar-pdf?cnpj=04486026000142");
  }

  const release = await acquire();
  let page;

  try {
    // 1) BrasilAPI
    const { data } = await axios.get(
      `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
      { timeout: 20000 }
    );
    const razao = data?.razao_social || "Não encontrado";
    let fantasia = (data?.nome_fantasia || "").trim();
    if (!fantasia || fantasia.toLowerCase() === "não encontrado") fantasia = razao;

    // 2) Data/Hora SP
    const formatter = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const dataHora = `${formatter.format(new Date())} (Horário SP)`;

    // 3) Template
    const templatePath = path.join(process.cwd(), "template.html");
    if (!fs.existsSync(templatePath)) throw new Error(`template.html não encontrado em ${templatePath}`);
    const htmlTemplate = fs.readFileSync(templatePath, "utf8");
    const html = htmlTemplate
      .replace(/{{CNPJ}}/g, cnpj)
      .replace(/{{RAZAO}}/g, razao)
      .replace(/{{FANTASIA}}/g, fantasia)
      .replace(/{{DATA_HORA}}/g, dataHora);

    // 4) Render
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.emulateMediaType("screen");
    try { await page.emulateTimezone("America/Sao_Paulo"); } catch {}

    // IMPORTANTE: se tiver fontes/links externos, deixe networkidle0.
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
      timeout: 0,
    });

    console.log("[/gerar-pdf] bytes:", pdfBuffer?.length);
    try { fs.writeFileSync("/tmp/last.pdf", pdfBuffer); } catch {}

    if (!pdfBuffer || pdfBuffer.length < 1024) {
      console.error("⚠️ PDF muito pequeno:", pdfBuffer?.length);
      return res.status(500).send("PDF gerado com tamanho inesperado");
    }

    const fileName = `Proposta Comercial PagBank - ${String(razao).replace(/[\\/:*?"<>|]/g, "")}.pdf`;

    // Cabeçalhos seguros; não setar Content-Length manualmente
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("❌ Erro ao gerar PDF:", err?.response?.data || err.message);
    return res.status(500).send("Erro ao gerar o PDF.");
  } finally {
    if (page) { try { await page.close({ runBeforeUnload: true }); } catch {} }
    release();
  }
});

app.get("/health", (_req, res) => res.send("ok"));

/* ============ STARTUP ============ */
prewarmChromium()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Teste rápido: http://localhost:${PORT}/pdf-test`);
      console.log(`🚀 Produção:    http://localhost:${PORT}/gerar-pdf?cnpj=04486026000142`);
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
