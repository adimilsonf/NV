/**
 * server.js v4.0 - Gerador de Alvará (Puppeteer full compatível com Railway)
 * -----------------------------------------------------------
 * • Usa puppeteer completo (não puppeteer-core)
 * • Chromium baixado automaticamente (sem snap) 
 * • Totalmente compatível com Railway e Nixpacks
 * -----------------------------------------------------------
 */

const express = require('express');
const bodyParser = require('body-parser');
const ejs = require('ejs');
const bwipjs = require('bwip-js');
const puppeteer = require('puppeteer'); // ✅ Puppeteer completo
const crypto = require('crypto');
const path = require('path');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// rota principal (formulário)
app.get('/', (req, res) => {
  res.render('form', { defaults: {} });
});

// rota para gerar PDF
app.post('/generate', async (req, res) => {
  try {
    const data = {
      credor: req.body.credor || 'Fulano de Tal',
      cpfCnpj: req.body.cpfCnpj || '000.000.000-00',
      advogado: req.body.advogado || 'Advogado',
      agencia: req.body.agencia || '0000',
      conta: req.body.conta || '000000',
      processo: req.body.processo || '0000000-00.0000.0.00.0000',
      contra: req.body.contra || 'Réu',
      assunto: req.body.assunto || 'Assunto',
      situacao: req.body.situacao || 'AUTORIZADO',
      valor: req.body.valor || 'R$ 0,00',
      dataEmissao: req.body.dataEmissao || new Date().toLocaleDateString('pt-BR'),
      observacoes: req.body.observacoes || ''
    };

    // Gera texto de código de barras aleatório
    const barcodeText = req.body.barcodeText && req.body.barcodeText.trim().length
      ? req.body.barcodeText.trim()
      : crypto.randomBytes(6).toString('hex').toUpperCase();

    // Gera o código de barras com bwip-js
    const pngBuffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: barcodeText,
      scale: 3,
      height: 20,
      includetext: false
    });
    const barcodeDataUri = 'data:image/png;base64,' + pngBuffer.toString('base64');

    // Renderiza HTML do template
    const html = await ejs.renderFile(path.join(__dirname, 'views', 'alvara.ejs'), {
      data,
      barcodeDataUri,
      barcodeText
    });

    // Inicia Puppeteer com Chromium interno (baixado automaticamente)
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Gera o PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' }
    });

    await browser.close();

    // Retorna o PDF para download
    const filename = `alvara_${Date.now()}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    return res.send(pdfBuffer);

  } catch (err) {
    console.error('❌ Erro ao gerar PDF:', err);
    return res.status(500).send('Erro ao gerar PDF: ' + err.message);
  }
});

// healthcheck (Railway usa para validar serviço)
app.get('/_health', (_req, res) => res.json({ status: 'ok' }));

// inicia servidor
const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT} (PORT=${PORT})`);
});
