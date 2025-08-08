const express = require("express");
const fs = require("fs");
const axios = require("axios");
const puppeteer = require("puppeteer");

const app = express();

app.get("/gerar-pdf", async (req, res) => {
  req.setTimeout(120000); // evita timeout no Railway

  const cnpj = (req.query.cnpj || "").replace(/\D/g, "");
  if (!cnpj) {
    return res.status(400).send("❌ Informe um CNPJ na URL, ex: /gerar-pdf?cnpj=04486026000142");
  }

  try {
    // 🔹 Consulta API BrasilAPI
    const { data } = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);

    const razao = data.razao_social || "Não encontrado";
    let fantasia = data.nome_fantasia || "";
    if (!fantasia || fantasia.trim().toLowerCase() === "não encontrado") {
      fantasia = razao;
    }
    const formatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});
const dataHora = `${formatter.format(new Date())} (Horário SP)`;

    // 🔹 Lê template HTML
    let html = fs.readFileSync("template.html", "utf8");
    html = html
      .replace("{{CNPJ}}", cnpj)
      .replace("{{RAZAO}}", razao)
      .replace("{{FANTASIA}}", fantasia)
      .replace("{{DATA_HORA}}", dataHora);

    // 🔹 Inicia Puppeteer com flags para Railway
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    // 🔹 Gera PDF em memória
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();

    // 🔹 Nome do arquivo
    const fileName = `Proposta Comercial PagBank - ${razao}.pdf`.replace(/[\\/:*?"<>|]/g, "");

    // 🔹 Retorna PDF para download direto
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    });

    res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ Erro ao gerar PDF:", err.message);
    res.status(500).send("Erro ao gerar o PDF.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT}/gerar-pdf?cnpj=04486026000142`));

