const express = require('express');
const bodyParser = require('body-parser');
const ejs = require('ejs');
const bwipjs = require('bwip-js');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const path = require('path');
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.render('form', { defaults: {} });
});

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
      dataEmissao: req.body.dataEmissao || '22 de outubro de 2024',
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

    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' }
    });
    await browser.close();

    const filename = `alvara_${Date.now()}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);

  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao gerar o PDF: ' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
