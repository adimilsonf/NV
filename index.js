/**
 * server.js - chromium auto-detect (robusto para Nixpacks / Railway)
 */

const express = require('express');
const bodyParser = require('body-parser');
const ejs = require('ejs');
const bwipjs = require('bwip-js');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

function findChromiumBinary() {
  const candidates = [];

  // 1) explicit env var
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  // 2) common linux paths (non-snap)
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium');

  // 3) look into /nix/store for chromium packages (Nixpacks)
  try {
    const nixRoot = '/nix/store';
    if (fs.existsSync(nixRoot)) {
      const entries = fs.readdirSync(nixRoot);
      for (const e of entries) {
        // heurística: nome com 'chromium' ou 'chromium-' ou 'chromium' anywhere
        if (e.toLowerCase().includes('chromium')) {
          const candidate = path.join(nixRoot, e, 'bin', 'chromium');
          candidates.push(candidate);
          // também chrome:
          candidates.push(path.join(nixRoot, e, 'bin', 'google-chrome'));
        }
      }
    }
  } catch (err) {
    // ignore
  }

  // 4) try `which chromium` and `which google-chrome`
  try {
    const whichChromium = execSync('which chromium || true').toString().trim();
    if (whichChromium) candidates.push(whichChromium);
  } catch (err) { /* ignore */ }
  try {
    const whichGC = execSync('which google-chrome || true').toString().trim();
    if (whichGC) candidates.push(whichGC);
  } catch (err) { /* ignore */ }

  // check candidates for existence + executable
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) {
        // sanity check: ensure it's not a snap stub that requires snap (skip /usr/bin/chromium-browser if it contains 'snap' text)
        // we will try to run with --version to ensure it is executable
        try {
          const out = execSync(`${c} --version`, { timeout: 3000 }).toString();
          if (/Chromium|Chrome/i.test(out)) {
            return c;
          }
        } catch (err) {
          // not runnable -> skip
        }
      }
    } catch (err) {
      // ignore and continue
    }
  }

  return null;
}

app.post('/generate', async (req, res) => {
  try {
    const data = {
      credor: req.body.credor || 'Fulano',
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

    const pngBuffer = await bwipjs.toBuffer({ bcid: 'code128', text: barcodeText, scale: 3, height: 20, includetext: false });
    const barcodeDataUri = 'data:image/png;base64,' + pngBuffer.toString('base64');

    const html = await ejs.renderFile(path.join(__dirname, 'views', 'alvara.ejs'), { data, barcodeDataUri, barcodeText });

    const chromiumPath = findChromiumBinary();
    if (!chromiumPath) {
      console.error('Chromium binary not found. Candidates exhausted.');
      console.error('To debug, run `ls -la /nix/store | head` in the build logs or set CHROME_PATH env var.');
      return res.status(500).send(
        'Erro ao iniciar o Chromium no servidor. Não foi encontrado um binário Chromium executável.\n' +
        'Dicas:\n' +
        ' - Adicione "chromium" em NIXPACKS_PKGS no railway.toml.\n' +
        ' - Defina a variável CHROME_PATH com o path correto (ex: /nix/store/.../bin/chromium).\n' +
        ' - Confira os logs do build para localizar o path dentro de /nix/store.\n'
      );
    }

    console.log('Usando Chromium em:', chromiumPath);

    const launchOptions = {
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--disable-gpu']
    };

    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' } });

    await browser.close();

    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="alvara_${Date.now()}.pdf"`, 'Content-Length': pdfBuffer.length });
    return res.send(pdfBuffer);

  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    return res.status(500).send('Erro ao gerar PDF: ' + err.message);
  }
});

app.get('/', (req, res) => res.render('form', { defaults: {} }));
app.get('/_health', (_req, res) => res.json({ status: 'ok' }));

const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT} (PORT=${PORT})`));
