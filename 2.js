const express = require("express");
const fs = require("fs");
const axios = require("axios");
const puppeteer = require("puppeteer");
const path = require("path");

const app = express();

app.get("/gerar-pdf", async (req, res) => {
  const cnpj = (req.query.cnpj || "").replace(/\D/g, "");

  if (!cnpj) {
    return res.status(400).send("❌ Informe um CNPJ na URL, ex: /gerar-pdf?cnpj=04486026000142");
  }

  try {
    // 🔹 Consulta BrasilAPI
    const { data } = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
    const razao = data.razao_social || "Não encontrado";
let fantasia = data.nome_fantasia || "";

if (!fantasia || fantasia.trim().toLowerCase() === "não encontrado") {
  fantasia = razao; // 🔹 Usa a razão social como nome fantasia
}
    const dataHora = new Date().toLocaleString("pt-BR");

    // 🔹 Lê template HTML
    let html = fs.readFileSync("template.html", "utf8");
    html = html
      .replace("{{CNPJ}}", cnpj)
      .replace("{{RAZAO}}", razao)
      .replace("{{FANTASIA}}", fantasia)
      .replace("{{DATA_HORA}}", dataHora);

    // 🔹 Gera PDF
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const fileName = `Proposta Comercial PagBank - ${razao}.pdf`.replace(/[\\/:*?"<>|]/g, ""); // remove caracteres inválidos
    const filePath = path.join(__dirname, fileName);

    await page.pdf({ path: filePath, format: "A4", printBackground: true });
    await browser.close();

    // 🔹 Retorna o PDF para download
    res.download(filePath, fileName, () => {
      // Opcional: excluir o arquivo após enviar
      setTimeout(() => fs.unlinkSync(filePath), 5000);
    });

  } catch (err) {
    console.error("❌ Erro:", err.message);
    res.status(500).send("Erro ao gerar o PDF.");
  }
});

app.listen(3000, () => {
  console.log("🚀 Servidor rodando em http://localhost:3000/gerar-pdf?cnpj=04486026000142");
});
