const express = require("express");
const fs = require("fs");
const axios = require("axios");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const PORT = process.env.PORT || 3000;
// Limite de concorrência simples para estabilidade em Railway
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2", 10);

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    const executablePath = await chromium.executablePath;
    browserPromise = puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process"
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: true
    });
  }
  return browserPromise;
}

// Semáforo simples
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

const app = express();

app.get("/gerar-pdf", async (req, res) => {
  req.setTimeout(120000); // evita timeout

  const cnpj = (req.query.cnpj || "").replace(/\D/g, "");
  if (!cnpj) {
    return res
      .status(400)
      .send("❌ Informe um CNPJ na URL, ex: /gerar-pdf?cnpj=04486026000142");
  }

  const release = await acquire();
  let page;
  try {
    // 1) Busca na BrasilAPI
    const { data } = await axios.get(
      `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
      { timeout: 20000 }
    );

    const razao = data.razao_social || "Não encontrado";
    let fantasia = (data.nome_fantasia || "").trim();
    if (!fantasia || fantasia.toLowerCase() === "não encontrado") fantasia = razao;

    // 2) Data/Hora SP (lado do servidor)
    const formatter = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    const dataHora = `${formatter.format(new Date())} (Horário SP)`;

    // 3) Template
    let html = fs.readFileSync("template.html", "utf8");
    html = html
      .replace(/{{CNPJ}}/g, cnpj)
      .replace(/{{RAZAO}}/g, razao)
      .replace(/{{FANTASIA}}/g, fantasia)
      .replace(/{{DATA_HORA}}/g, dataHora);

    // 4) Chromium compatível Railway (browser singleton)
    const browser = await getBrowser();
    page = await browser.newPage();

    // TZ dentro do Chromium (evita divergência em scripts do HTML)
    try { await page.emulateTimezone("America/Sao_Paulo"); } catch {}

    await page.setContent(html, { waitUntil: "networkidle0", timeout: 45000 });

    // 5) PDF em memória
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });

    const fileName = `Proposta Comercial PagBank - ${razao}.pdf`
      .replace(/[\\/:*?"<>|]/g, "");

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`
    });
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

app.listen(PORT, () => {
  console.log(`🚀 http://localhost:${PORT}/gerar-pdf?cnpj=04486026000142`);
});

// Encerramento gracioso
process.on("SIGTERM", async () => {
  if (browserPromise) {
    try { (await browserPromise).close(); } catch {}
  }
  process.exit(0);
});
