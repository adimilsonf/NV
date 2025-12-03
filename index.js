/**
 * server.js v5.3 - Alvará Generator (fix:removed page.waitForTimeout -> sleep)
 *
 * • Usa puppeteer completo
 * • Converte logo remota para dataURI para evitar timeouts
 * • Reusa browser, stream seguro do PDF
 * • Compatível com Railway
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
const https = require('https');

const writeFile = util.promisify(fs.writeFile);
const unlink = util.promisify(fs.unlink);
const tmpDir = os.tmpdir();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

let browser;

// small sleep util - works in any Node/Puppeteer version
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// util: baixa uma imagem HTTPS e retorna Buffer (ou lança erro)
function fetchImageBuffer(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const req = https.get(url, { timeout }, (res) => {
        const { statusCode } = res;
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error('Image fetch failed. Status: ' + statusCode));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('timeout', () => {
        req.destroy(new Error('Image fetch timeout'));
      });
      req.on('error', (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

// converte buffer + mimeType para data URI
function bufferToDataUri(buffer, mime = 'image/png') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

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

// rota principal
app.get('/', (req, res) => res.render('form', { defaults: {} }));

// rota generate (fetch logo -> dataURI -> render -> pdf)
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

    // barcode
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

    // === LOGO: fetch + convert to dataURI ===
    const logoUrl = (req.body.logoUrl && req.body.logoUrl.trim()) || 'https://www.tjrs.jus.br/novo/eproc/wp-content/themes/eproc/images/Logotipo-Brasao-retangular-lettering-em-preto.png';
    let logoDataUri = null;
    try {
      const imgBuf = await fetchImageBuffer(logoUrl, 15000); // timeout 15s
      // detect mime type
      let mime = 'image/png';
      const header = imgBuf.slice(0, 8).toString('hex').toLowerCase();
      if (header.startsWith('ffd8')) mime = 'image/jpeg';
      if (header.includes('89504e47')) mime = 'image/png';
      if (header.includes('47494638')) mime = 'image/gif';
      logoDataUri = bufferToDataUri(imgBuf, mime);
      console.log('✅ Logo convertida para dataURI (bytes):', imgBuf.length);
    } catch (err) {
      console.warn('⚠️ Falha ao buscar a logo externa, seguindo sem logo. Erro:', err.message);
      const localPath = path.join(__dirname, 'public', 'assets', 'logo_page.png');
      if (fs.existsSync(localPath)) {
        const localBuf = fs.readFileSync(localPath);
        logoDataUri = bufferToDataUri(localBuf, 'image/png');
        console.log('✅ Usando logo local em public/assets/logo_page.png');
      } else {
        logoDataUri = null;
      }
    }

    // render HTML passing logoDataUri
    const html = await ejs.renderFile(path.join(__dirname, 'views', 'alvara.ejs'), {
      data,
      barcodeDataUri,
      barcodeText,
      logoDataUri
    });

    // Inicia browser (reuso)
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    // Use domcontentloaded (faster, network requests are not necessary because images are data URIs)
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // brief sleep to be safe (replaces page.waitForTimeout)
    await sleep(200);

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' }
    });

    await page.close();

    // sanity check
    if (!pdfBuffer || pdfBuffer.length < 1000) {
      console.error('⚠️ PDF gerado inválido:', pdfBuffer ? pdfBuffer.length : 'null');
      return res.status(500).send('Erro: PDF gerado inválido.');
    }
    console.log('✅ PDF gerado com sucesso:', pdfBuffer.length, 'bytes');

    // save temp and stream
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
      try { await unlink(tmpPath); } catch (e) { /* ignore */ }
    });
    stream.on('error', async (err) => {
      console.error('Erro no stream do PDF:', err);
      try { await unlink(tmpPath); } catch (e) { /* ignore */ }
      if (!res.headersSent) res.status(500).send('Erro ao enviar PDF.');
    });

  } catch (err) {
    console.error('❌ Erro ao gerar PDF:', err);
    if (browser && !browser.isConnected()) browser = null;
    return res.status(500).send('Erro ao gerar PDF: ' + (err.message || err));
  }
});

// healthcheck
app.get('/_health', (_req, res) => res.json({ status: 'ok' }));

// start
const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT} (PORT=${PORT})`));

// encerra browser ao sair
process.on('exit', async () => {
  if (browser) try { await browser.close(); } catch (e) {}
});
