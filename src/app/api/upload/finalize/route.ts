import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { saveToInbox } from '@/lib/inbox/save-to-inbox';
import { processFileDigests } from '@/lib/digest';

const DATA_ROOT = process.env.MY_DATA_DIR || path.join(process.cwd(), 'data');
const UPLOAD_DIR = path.join(DATA_ROOT, 'app', 'my-life-db', 'uploads');

interface FinalizeRequest {
  uploads: Array<{
    uploadId: string;
    filename: string;
    size: number;
    type: string;
  }>;
  text?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: FinalizeRequest = await request.json();
    const { uploads, text } = body;

    if (!uploads || uploads.length === 0) {
      return NextResponse.json(
        { error: 'No uploads provided' },
        { status: 400 }
      );
    }

    // Read uploaded files from tus storage
    const files: Array<{
      filename: string;
      buffer: Buffer;
      mimeType: string;
      size: number;
    }> = [];

    for (const upload of uploads) {
      // Tus stores files as {uploadId} (no extension)
      const tusFilePath = path.join(UPLOAD_DIR, upload.uploadId);
      const metadataPath = `${tusFilePath}.json`;

      if (!existsSync(tusFilePath)) {
        console.error(`[FINALIZE] Upload file not found: ${tusFilePath}`);
        continue;
      }

      // Read the file
      const buffer = await fs.readFile(tusFilePath);

      files.push({
        filename: upload.filename,
        buffer,
        mimeType: upload.type,
        size: upload.size,
      });

      // Clean up tus file and metadata
      try {
        await fs.unlink(tusFilePath);
        if (existsSync(metadataPath)) {
          await fs.unlink(metadataPath);
        }
      } catch (err) {
        console.error('[FINALIZE] Error cleaning up tus files:', err);
      }
    }

    if (files.length === 0 && !text) {
      return NextResponse.json(
        { error: 'No valid files or text to save' },
        { status: 400 }
      );
    }

    // Save to inbox using existing logic
    const result = await saveToInbox({
      text: text || undefined,
      files: files.length > 0 ? files : undefined,
    });

    // Trigger digest processing (fire and forget)
    processFileDigests(result.path).catch((error: unknown) => {
      console.error('[FINALIZE] Error processing digests:', error);
    });

    return NextResponse.json(
      {
        success: true,
        path: result.path,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[FINALIZE] Error finalizing upload:', error);
    return NextResponse.json(
      { error: 'Failed to finalize upload' },
      { status: 500 }
    );
  }
}
