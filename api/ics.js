// Gera um evento .ics (RFC 5545) sob demanda, via GET com querystring —
// "Salvar na agenda" precisa navegar pra uma URL http(s) de verdade, não
// um blob:/data: URI gerado no cliente. Blob/data são referências presas
// ao documento/contexto que criou; abrir em nova aba (ou até navegar a
// própria aba, no caso de blob:) faz o Safari do iPhone não conseguir
// resolver o conteúdo — trava numa tela em branco "carregando" pra
// sempre (bug real, achado num iPhone, depois de 2 tentativas só no
// cliente). Uma URL de servidor de verdade, com Content-Type
// text/calendar, é o jeito padrão (e testado) de fazer o iOS reconhecer
// e abrir a prévia nativa de "Adicionar evento".
function esc(s) {
    return String(s || '').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
}

export default function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).send('Method not allowed.');
        return;
    }
    const title = String(req.query.title || 'Evento');
    const description = String(req.query.description || '');
    const date = String(req.query.date || '').replace(/-/g, '');
    if (!/^\d{8}$/.test(date)) {
        res.status(400).send('Data inválida.');
        return;
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const uid = 'agendamento-' + Date.now() + '@appdevisitas';
    const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//App de Visitas//PT-BR',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${date}`,
        `SUMMARY:${esc(title)}`,
        `DESCRIPTION:${esc(description)}`,
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.status(200).send(ics);
}
