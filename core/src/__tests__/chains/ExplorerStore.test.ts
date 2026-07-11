import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExplorerStore, explorerUrlHash, normalizeExplorerUrl } from '../../chains/ExplorerStore.js';
import { VerifierProviderService } from '../../chains/VerifierProviderService.js';

const dirs: string[] = [];
async function store() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-explorers-')); dirs.push(dir); return new ExplorerStore({baseDir:dir,randomUUID:() => 'fixed'}); }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir,{recursive:true,force:true}))); });

describe('ExplorerStore', () => {
  it('persists selections and overlays while serializing mutations', async () => {
    const subject = await store();
    const manual = await subject.add({chainId:1,url:'HTTPS://Explorer.Example/'});
    await Promise.all([subject.setSelection(1,[manual.id]),subject.update('chain:1:abc',{verifierPluginId:'etherscan',label:'Confirmed'})]);
    expect(await subject.getSelection(1)).toEqual([manual.id]);
    expect((await subject.overlays(1))['chain:1:abc']).toMatchObject({verifierPluginId:'etherscan',label:'Confirmed'});
    expect((await subject.list(1))[0].url).toBe('https://explorer.example');
  });
  it('uses full stable sha256 URL ids and rejects credentials', async () => {
    expect(explorerUrlHash('https://example.test/')).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizeExplorerUrl('https://EXAMPLE.test/a/')).toBe('https://example.test/a');
    const subject = await store();
    await expect(subject.add({chainId:1,url:'https://key:secret@example.test'})).rejects.toMatchObject({code:'EXPLORER_URL_CREDENTIALS'});
  });
  it('quarantines corrupt state rather than crashing startup', async () => {
    const subject = await store();
    await fs.writeFile(path.join(dirs[0],'explorers.json'), '{not-json');
    expect(await subject.list(1)).toEqual([]);
    await expect(fs.access(path.join(dirs[0],'explorers.json.bad'))).resolves.toBeUndefined();
  });
});

describe('VerifierProviderService', () => {
  it('degrades an individual provider error into a status row', async () => {
    const subject = new VerifierProviderService({
      getProviders: async () => [{id:'bad',name:'Bad'},{id:'good',name:'Good'}],
      execute: async (id) => id === 'bad' ? {success:false,error:{code:'NOPE',message:'bad'}} : {success:true,data:{explorers:[{chainId:1,explorerUrl:'https://good.test'}],urlPatterns:['good']}} as any,
      logger:{warn:()=>{}},
    });
    const result = await subject.getDetected(1);
    expect(result.entries).toHaveLength(1);
    expect(result.statuses).toEqual(expect.arrayContaining([expect.objectContaining({pluginId:'bad',state:'error'})]));
  });
});
