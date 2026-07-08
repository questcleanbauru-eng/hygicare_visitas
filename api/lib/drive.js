import { getAuthClient } from './sheets.js';

const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

// Upload multipart (metadata + conteúdo) numa única requisição, igual ao que
// o Drive UI faz — evita a etapa extra de "resumable upload" pra arquivos
// pequenos como um PDF de contrato.
export async function uploadFileToDrive({ base64, filename, mimeType, folderId }) {
    const folder = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folder) throw new Error('GOOGLE_DRIVE_FOLDER_ID não configurada.');

    const client = getAuthClient();
    const { token } = await client.getAccessToken();

    const boundary = 'appvisitas-' + Date.now();
    const metadata = JSON.stringify({ name: filename, parents: [folder] });
    const fileBuffer = Buffer.from(base64, 'base64');

    const body = Buffer.concat([
        Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
            `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
        ),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}--`)
    ]);

    const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,webViewLink`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Drive API ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
}
