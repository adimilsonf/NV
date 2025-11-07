/**
 * server.js v2.0
 * Gerador de Alvará -> recebe dados via formulário, gera barcode com bwip-js,
 * renderiza EJS e cria PDF usando puppeteer-core apontando para o Chromium do sistema.
 *
 * Ajuste: defina CHROME_PATH se o Chromium estiver em local diferente.
 */

const express = require('express');
const bodyParser = require('body-parser');
const ejs = require('ejs');
const bwipjs = require('bwip-js');
const puppeteer = require('puppeteer-core'); // usamos puppeteer-core para não forçar download do Chromium
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// serve arquivos estáticos (styles + assets)
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// rota do formulário
app.get('/', (req, res) => {
  res.render('form', { defaults: {} });
});

// POST para gerar PDF
app.post('/generate', async (req, res) => {
  try {
    const data = {
      credor: req.body.credor || 'Andreia De Jesus Pedrosa Figueira',
      cpfCnpj: req.body.cpfCnpj || '283.728.898-56',
      advogado: req.body.advogado || 'Edson Paulo Lins Junior',
      agencia: req.body.agencia || '5198',
      conta: req.body.conta || '14068-2',
      processo: req.body.processo || '001XXXX-23.2027.8.27.2706',
      contra: req.body.contra || 'Luis Antunes',
      assunto: req.body.assunto || 'Liquidação / Cumprimento / Execução',
      situacao: req.body.situacao || 'AUTORIZADO',
      valor: req.body.valor || 'R$ 39.874,98',
      dataEmissao: req.body.dataEmissao || new Date().toLocaleDateString('pt-BR'),
      observacoes: req.body.observacoes || ''
    };

    // barcode text (opcional no form)
    const barcodeText = req.body.barcodeText && req.body.barcodeText.trim().length
      ? req.body.barcodeText.trim()
      : crypto.randomBytes(6).toString('hex').toUpperCase();

    // gerar png do barcode com bwip-js
    const pngBuffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: barcodeText,
      scale: 3,
      height: 20,
      includetext: false
    });
    const barcodeDataUri = 'data:image/png;base64,' + pngBuffer.toString('base64');

    // renderizar HTML (views/alvara.ejs)
    const html = await ejs.renderFile(path.join(__dirname, 'views', 'alvara.ejs'), {
      data,
      barcodeDataUri,
      barcodeText
    });

    // localizar possível caminho do Chromium no ambiente
    const possibleChromiumPaths = [
      process.env.CHROME_PATH,                    // optional env var
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome'
    ].filter(Boolean);

    let executablePath = null;
    for (const p of possibleChromiumPaths) {
      try {
        if (fs.existsSync(p)) {
          executablePath = p;
          break;
        }
      } catch (err) {
        // ignore
      }
    }

    // Mensagem informativa
    if (!executablePath) {
      console.warn('AVISO: Não foi encontrado um binário Chromium nos caminhos padrão. ' +
        'Defina a variável de ambiente CHROME_PATH ou instale chromium no runtime (NIXPACKS_PKGS inclui "chromium").');
    } else {
      console.log('Usando Chromium em:', executablePath);
    }

    // iniciar puppeteer-core apontando para o Chromium do sistema (se disponível)
    let browser;
    try {
      const launchOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process'
        ]
      };

      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }

      browser = await puppeteer.launch(launchOptions);
    } catch (err) {
      // se falhar, retornar erro amigável com instruções
      console.error('Erro ao iniciar o navegador headless:', err.message);
      return res.status(500).send(
        'Erro ao iniciar o Chromium no servidor. Se estiver em Railway/Nixpacks: ' +
        'adicione "chromium" em NIXPACKS_PKGS no railway.toml e defina CHROME_PATH se necessário. ' +
        'Detalhe técnico: ' + err.message
      );
    }

    const page = await browser.newPage();
    // garantir fontes e imagens locais resolvendo relativo com base em /public
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // gerar PDF A4
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' }
    });

    await browser.close();

    // enviar PDF como download
    const filename = `alvara_${Date.now()}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    return res.send(pdfBuffer);

  } catch (err) {
    console.error('Erro geral ao gerar PDF:', err);
    return res.status(500).send('Erro ao gerar o PDF: ' + err.message);
  }
});

// healthcheck
app.get('/_health', (req, res) => res.json({ status: 'ok' }));

// start
const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT} (PORT=${PORT})`);
});
