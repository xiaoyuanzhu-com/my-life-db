import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

const DATA_ROOT = process.env.MY_DATA_DIR || path.join(process.cwd(), 'data');
const UPLOAD_DIR = path.join(DATA_ROOT, 'app', 'my-life-db', 'uploads');

// Ensure upload directory exists
if (!existsSync(UPLOAD_DIR)) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

// Configure tus server
const tusServer = new Server({
  path: '/api/upload/tus',
  datastore: new FileStore({ directory: UPLOAD_DIR }),
});

// Handle all HTTP methods for tus protocol
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> }
) {
  return handleTusRequest(request, context);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> }
) {
  return handleTusRequest(request, context);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> }
) {
  return handleTusRequest(request, context);
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> }
) {
  return handleTusRequest(request, context);
}

export async function OPTIONS(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> }
) {
  return handleTusRequest(request, context);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> }
) {
  return handleTusRequest(request, context);
}

async function handleTusRequest(
  request: NextRequest,
  _context: { params: Promise<{ path?: string[] }> }
) {

  // Create a mock response object to capture tus server response
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: string | Buffer = '';

  const mockRes = {
    setHeader(key: string, value: string | number) {
      headers[key] = String(value);
    },
    writeHead(code: number, responseHeaders?: Record<string, string | number>) {
      statusCode = code;
      if (responseHeaders) {
        Object.entries(responseHeaders).forEach(([key, value]) => {
          headers[key] = String(value);
        });
      }
    },
    write(chunk: string | Buffer) {
      if (Buffer.isBuffer(chunk)) {
        body = Buffer.concat([Buffer.isBuffer(body) ? body : Buffer.from(body), chunk]);
      } else {
        body = (Buffer.isBuffer(body) ? body.toString() : body) + chunk;
      }
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        if (Buffer.isBuffer(chunk)) {
          body = Buffer.concat([Buffer.isBuffer(body) ? body : Buffer.from(body), chunk]);
        } else {
          body = (Buffer.isBuffer(body) ? body.toString() : body) + chunk;
        }
      }
    },
  };

  // Convert Next.js request to Node.js format
  const reqHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    reqHeaders[key.toLowerCase()] = value;
  });

  // Get request body as buffer
  let bodyBuffer: Buffer | undefined;
  if (request.method === 'PATCH' || request.method === 'POST') {
    const arrayBuffer = await request.arrayBuffer();
    bodyBuffer = Buffer.from(arrayBuffer);
  }

  const mockReq = {
    method: request.method,
    headers: reqHeaders,
    url: request.url.replace(request.nextUrl.origin, ''),
    body: bodyBuffer,
  };

  // Handle the request with tus server
  try {
    await tusServer.handle(mockReq as any, mockRes as any);

    // Convert response
    const responseHeaders = new Headers();
    Object.entries(headers).forEach(([key, value]) => {
      responseHeaders.set(key, value);
    });

    return new NextResponse(body, {
      status: statusCode,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('[TUS] Error handling request:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
