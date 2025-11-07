/**
 * server.js v5.0 - Gerador de Alvará (Puppeteer full + Streaming fix)
 * -----------------------------------------------------------
 * • Usa puppeteer completo (Chromium baixado automaticamente)
 * • Corrigido envio binário do PDF (stream seguro)
 * • Compatível com Railway e Nixpacks
 * • Verifica integridade e logs detalhados
 * -----------------------------------------------------------
 */

const express = require('express');
const bodyParser = require('body-parser');
const ejs = require('ejs');
const bwipjs = require('bwip-js');
const puppeteer = require('puppeteer'); // ✅ Puppeteer completo
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

// rota principal (formulário)
app.get('/', (req, res) => {
  res.render('form', { defaults: {} });
});

// rota para gerar PDF (corrigida)
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

    // Gera texto do código de barras aleatório
    const barcodeText = req.body.barcodeText && req.body.barcodeText.trim().length
      ? req.body.barcodeText.trim()
      : crypto.randomBytes(6).toString('hex').toUpperCase();

    // Gera o código de barras (base64)
    const pngBuffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: barcodeText,
      scale: 3,
      height: 20,
      includetext: false
    });
    const barcodeDataUri = 'data:image/png;base64,' + pngBuffer.toString('base64');

    // Renderiza o HTML do alvará
    const html = await ejs.renderFile(path.join(__dirname, 'views', 'alvara.ejs'), {
      data,
      barcodeDataUri,
      barcodeText
    });

    // Inicia o Chromium headless do Puppeteer
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

    // Gera o PDF com margens corretas
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' }
    });

    await browser.close();

    // Verifica integridade do buffer
    if (!pdfBuffer || pdfBuffer.length < 1000) {
      console.error('⚠️ PDF gerado com tamanho inválido:', pdfBuffer ? pdfBuffer.length : 'null');
      return res.status(500).send('Erro ao gerar PDF (arquivo vazio ou corrompido).');
    }

    console.log('✅ PDF gerado com sucesso:', pdfBuffer.length, 'bytes');

    // Salva o arquivo temporariamente
    const tmpFilename = `alvara_${Date.now()}.pdf`;
    const tmpPath = path.join(tmpDir, tmpFilename);
    await writeFile(tmpPath, pdfBuffer, { encoding: 'binary' });

    // Define headers binários e evita compressão
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${tmpFilename}"`);
    res.setHeader('Content-Transfer-Encoding', 'binary');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Content-Length', pdfBuffer.length.toString());

    // Faz o stream do arquivo temporário
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);

    // Remove o arquivo ao finalizar
    stream.on('end', async () => {
      try { await unlink(tmpPath); } catch (e) { /* ignora */ }
    });

    stream.on('error', async (err) => {
      console.error('Erro ao ler o arquivo temporário do PDF:', err);
      try { await unlink(tmpPath); } catch (e) { /* ignora */ }
      if (!res.headersSent) res.status(500).send('Erro ao enviar PDF.');
    });

  } catch (err) {
    console.error('❌ Erro ao gerar PDF:', err);
    res.status(500).send('Erro ao gerar PDF: ' + err.message);
  }
});

// healthcheck (para Railway)
app.get('/_health', (_req, res) => res.json({ status: 'ok' }));

// Inicia servidor
const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT} (PORT=${PORT})`);
});
