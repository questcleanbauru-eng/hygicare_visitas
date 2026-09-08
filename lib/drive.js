import { JWT } from 'google-auth-library';

// Upload de arquivos (fotos do Relatório de Manutenção, PDFs de Contrato)
// pro Google Drive. O app entra como a MESMA conta de serviço usada pra
// Planilha (GOOGLE_SERVICE_ACCOUNT_KEY), só que aqui pedimos também o escopo
// de Drive. Pré-requisitos manuais (uma vez):
//   1. Ativar a "Google Drive API" no projeto do Google Cloud.
//   2. Compartilhar cada pasta de destino com o e-mail da conta de serviço
//      (client_email do JSON) como Editor.
// A conta de serviço não tem cota de armazenamento própria: o que ela sobe
// conta pro dono da pasta (a mesma conta Google que é dona da planilha).

const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

// Pastas que o cliente compartilhou. Trocáveis por env var (redeploy pega).
export const FOTOS_MANUTENCAO_FOLDER_ID =
    process.env.DRIVE_FOTOS_MANUTENCAO_FOLDER_ID || '1sSzi32oW7nV1dTp50UJgA2vLnEi80UkR';
export const CONTRATOS_FOLDER_ID =
    process.env.DRIVE_CONTRATOS_FOLDER_ID || '1Z7D0NNQ5c2Y__KqJkYXym-LMOvmT12mz';

let _driveClient = null;
let _saEmail = '';
export function serviceAccountEmail() { return _saEmail; }
function getDriveClient() {
    if (_driveClient) return _driveClient;
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY não configurada.');
    const key = JSON.parse(raw);
    _saEmail = key.client_email || '';
    _driveClient = new JWT({
        email: key.client_email,
        key: key.private_key,
        // 'drive' (e não 'drive.file'): o escopo restrito só enxerga arquivos
        // que o PRÓPRIO app criou — não uma pasta compartilhada na mão. Numa
        // conta de serviço sem delegação de domínio, 'drive' só alcança o que
        // já foi compartilhado com ela + o que ela cria, então segue seguro.
        scopes: ['https://www.googleapis.com/auth/drive']
    });
    return _driveClient;
}

async function driveToken() {
    const { token } = await getDriveClient().getAccessToken();
    return token;
}

const MIME_RULES = {
    image: { test: /^image\/(jpe?g|png|webp)$/i, maxBytes: 8 * 1024 * 1024, label: 'imagem' },
    pdf: { test: /^application\/pdf$/i, maxBytes: 15 * 1024 * 1024, label: 'PDF' }
};

function extFor(mime) {
    if (/pdf/i.test(mime)) return 'pdf';
    if (/png/i.test(mime)) return 'png';
    if (/webp/i.test(mime)) return 'webp';
    return 'jpg';
}

// Aceita uma data URL ("data:<mime>;base64,....") OU base64 puro + mimeType.
export async function uploadToDrive({ folderId, name, dataUrl, base64, mimeType, kind = 'image' }) {
    const rule = MIME_RULES[kind] || MIME_RULES.image;
    let mime = mimeType || '';
    let b64 = base64 || '';
    if (dataUrl) {
        const m = String(dataUrl).match(/^data:([^;,]+);base64,(.*)$/s);
        if (!m) throw new Error('Arquivo inválido.');
        mime = m[1];
        b64 = m[2];
    }
    if (!b64) throw new Error('Arquivo vazio.');
    if (!rule.test.test(mime)) throw new Error(`Formato de ${rule.label} não suportado.`);

    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length > rule.maxBytes) {
        throw new Error(`Arquivo muito grande (máx. ${Math.round(rule.maxBytes / (1024 * 1024))} MB).`);
    }

    const token = await driveToken();
    const finalName = (name && String(name).trim())
        ? String(name).trim().replace(/[\\/:*?"<>|]/g, '-')
        : `arquivo-${Date.now()}.${extFor(mime)}`;

    const boundary = 'apv' + Math.random().toString(36).slice(2);
    const meta = { name: finalName, parents: folderId ? [folderId] : undefined };
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
        Buffer.from(JSON.stringify(meta)),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error('Drive upload', res.status, txt.slice(0, 800));
        if (res.status === 403 || res.status === 404) {
            const sa = _saEmail || 'a conta de serviço';
            throw new Error(`Sem acesso à pasta do Drive. Compartilhe a pasta com ${sa} (Editor) e confirme que a Google Drive API está ativa.`);
        }
        if (res.status === 401) {
            throw new Error('Autenticação com o Google falhou (chave da conta de serviço).');
        }
        throw new Error(`Não foi possível enviar o arquivo (Drive ${res.status}).`);
    }
    const { id } = await res.json();

    // "Qualquer pessoa com o link" pode ler — senão a miniatura/o PDF não
    // abre no navegador de quem não tem acesso direto à pasta.
    try {
        await fetch(`${DRIVE_FILES}/${id}/permissions?supportsAllDrives=true`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'reader', type: 'anyone' })
        });
    } catch (e) { /* não fatal — dono da pasta ainda vê */ }

    return {
        id,
        thumbUrl: `https://drive.google.com/thumbnail?id=${id}&sz=w1000`,
        viewUrl: `https://drive.google.com/file/d/${id}/view`
    };
}

export async function deleteDriveFile(id) {
    if (!id) return;
    try {
        const token = await driveToken();
        await fetch(`${DRIVE_FILES}/${encodeURIComponent(id)}?supportsAllDrives=true`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
        });
    } catch (e) { console.error('Drive delete', e && e.message); }
}

export function driveThumb(id) {
    return `https://drive.google.com/thumbnail?id=${id}&sz=w1000`;
}
export function driveView(id) {
    return `https://drive.google.com/file/d/${id}/view`;
}
// "https://drive.google.com/file/d/<id>/view" -> "<id>"
export function driveIdFromUrl(url) {
    const m = String(url || '').match(/\/d\/([a-zA-Z0-9_-]{10,})|[?&]id=([a-zA-Z0-9_-]{10,})/);
    return m ? (m[1] || m[2]) : '';
}
