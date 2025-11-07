/**
 * server.js v5.1 - Alvará Generator (timeout fix + browser reuse)
 */

const express = require('express');
const bodyParser = require('body-parser');
const ejs = require('ejs');
const bwipjs = require('bwip-js');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');

const writeFile = util.promisify(fs.writeFile);
const unlink = util.promisify(fs.unlink);
const tmpDir = os.tmpdir();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

let browser; // reusar entre requisições

async function getBrowser() {
  try {
    if (!browser || !browser.isConnected()) {
      console.log('🚀 Iniciando nova instância do Chromium...');
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--single-process',
          '--disable-gpu'
        ]
      });
    }
    return browser;
  } catch (err) {
    console.error('❌ Erro ao iniciar o navegador:', err);
    throw err;
  }
}

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

    const barcodeText = req.body.barcodeText && req.body.barcodeText.trim().length
      ? req.body.barcodeText.trim()
      : crypto.randomBytes(6).toString('hex').toUpperCase();

    const pngBuffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: barcodeText,
      scale: 3,
      height: 20,
      includetext: false
    });
    const barcodeDataUri = 'data:image/png;base64,' + pngBuffer.toString('base64');

    const html = await ejs.renderFile(path.join(__dirname, 'views', 'alvara.ejs'), {
      data,
      barcodeDataUri,
      barcodeText
    });

    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    // aumenta timeout de navegação para 120s
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 120000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' }
    });

    await page.close();

    if (!pdfBuffer || pdfBuffer.length < 1000) {
      console.error('⚠️ PDF gerado com tamanho inválido:', pdfBuffer ? pdfBuffer.length : 'null');
      return res.status(500).send('Erro: PDF gerado inválido.');
    }

    const tmpFilename = `alvara_${Date.now()}.pdf`;
    const tmpPath = path.join(tmpDir, tmpFilename);
    await writeFile(tmpPath, pdfBuffer, { encoding: 'binary' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${tmpFilename}"`);
    res.setHeader('Content-Transfer-Encoding', 'binary');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Content-Length', pdfBuffer.length.toString());

    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);

    stream.on('end', async () => {
      try { await unlink(tmpPath); } catch { }
    });

    stream.on('error', async (err) => {
      console.error('Erro no stream de PDF:', err);
      try { await unlink(tmpPath); } catch { }
      if (!res.headersSent) res.status(500).send('Erro ao enviar PDF.');
    });

  } catch (err) {
    console.error('❌ Erro ao gerar PDF:', err);
    if (browser && !browser.isConnected()) browser = null; // força reinício
    res.status(500).send('Erro ao gerar PDF: ' + err.message);
  }
});

app.get('/', (req, res) => res.render('form', { defaults: {} }));
app.get('/_health', (_req, res) => res.json({ status: 'ok' }));

const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));

// encerra browser ao sair
process.on('exit', async () => {
  if (browser) await browser.close();
});
