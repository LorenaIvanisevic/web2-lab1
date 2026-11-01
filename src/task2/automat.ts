import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';


export async function getToken(
   authority: string,
   audience: string,
   clientId: string,
   clientSecret: string,
   scope: string
): Promise<string> {

   const body: Record<string, string> = {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
      scope
   };

   const res = await fetch(`${authority}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
   });

   if (!res.ok) {
      throw new Error(`Failed: ${res.status} ${res.statusText}`);
   }

   const data = (await res.json()) as { access_token?: string };
   if (!data.access_token) {
      throw new Error('Failed: response doesnt contain access_token');
   }
   return data.access_token;
}


export async function issuePass(
   url: string,
   token: string,
   name: string,
   document: string
): Promise<void> {

   const res = await fetch(url, {
      method: 'POST',
      headers: {
         Authorization: `Bearer ${token}`,
         'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, document }),
   });

   if (res.status !== 201) {
      throw new Error(`Failed: ${res.status} ${res.statusText}`);
   }

   const location = res.headers.get('Location');
   if (!location) {
      throw new Error('Location missing');
   }

   const id = new URL(location, url).pathname.split('/').filter(Boolean).pop();
   if (!id || !/^[\w-]+$/.test(id)) {
      throw new Error(`Incorrect id: ${location}`);
   }

   const png = Buffer.from(await res.arrayBuffer());
   await writeFile(`${id}.png`, png);
}