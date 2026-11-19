import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from test_client import APP
from flyleaf_desktop.document_backend import DocumentBackend
from flyleaf_desktop.epub_positions import EpubPositions


class NativeFormatTests(unittest.TestCase):
    def test_real_server_conversions_render_and_keep_virtual_source_cfis(self):
        root = Path(__file__).resolve().parents[2]
        if not shutil.which("node") or not (root / "node_modules/foliate-js").is_dir():
            self.skipTest("Install server dependencies for native format conversion contracts")
        with tempfile.TemporaryDirectory(dir=root / "desktop/build") as directory:
            script = r"""
const fs=require('node:fs/promises'), path=require('node:path');
const config=require('./server/config'); config.cacheDir=path.join(process.argv[1],'cache');
const native=require('./server/native-epub');
const convert=require('./server/formats');
(async()=>{
 const dir=process.argv[1], output=[];
 const samples={
   mobi: require('./tests/mobi-fixture.cjs')('<html><head><title>Sample</title></head><body><p>Before the quiet garden a native reader finds a new story.</p></body></html>'),
   azw3: require('./tests/kf8-fixture.cjs')('A native garden with a unique KF8 story.'),
   fb2: Buffer.from('<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>prose</genre><book-title>Native garden</book-title><lang>en</lang></title-info></description><body><section><title><p>The garden</p></title><p>A native garden contains a quiet place to read a unique story.</p></section></body></FictionBook>'),
   txt: Buffer.from('Native garden\n\nA quiet native garden contains a unique readable story.'),
   rtf: Buffer.from('{\\rtf1\\ansi Native garden\\par A quiet native garden contains a unique readable story.}')
 };
 const zip=new (require('jszip'))();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>A native garden contains a unique readable story.</w:t></w:r></w:p></w:body></w:document>');
 samples.docx=await zip.generateAsync({type:'nodebuffer'});
 for(const [format,raw] of Object.entries(samples)) {
   const file=path.join(dir,'sample.'+format); await fs.writeFile(file,raw);
   const result=['fb2','mobi','azw3'].includes(format)?await native.toNativeEpub({path:file,format,title:'Native garden'}):await convert.toEpub(file,format,'Native garden');
   let anchors=[];
   if(['fb2','mobi','azw3'].includes(format)) {
     const {Worker}=require('node:worker_threads');
     const message=await new Promise((resolve,reject)=>{
       const worker=new Worker(path.join(process.cwd(),'server/native-epub-worker.js'),{workerData:{file,format,verify:true}});
       worker.once('message',value=>{worker.terminate();value.error?reject(Error(value.error)):resolve(value)});worker.once('error',reject);
     });
     anchors=message.anchors;
   }
   output.push({format,path:result,anchors});
 }
 console.log(JSON.stringify(output));
})().catch(error=>{console.error(error);process.exitCode=1});
"""
            result = subprocess.run(["node", "-e", script, directory], cwd=root, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            for sample in json.loads(result.stdout):
                with self.subTest(format=sample["format"]):
                    backend = DocumentBackend()
                    try:
                        payload = Path(sample["path"]).read_bytes()
                        positions = EpubPositions(payload)
                        metadata = backend.open(payload, "epub")
                        self.assertGreater(metadata["count"], 0)
                        page = backend.render(0, width=600)
                        self.assertIn("garden", page["text"].lower())
                        self.assertTrue(page["image"].startswith(b"\x89PNG"))
                        self.assertTrue(page["position"].startswith("epubcfi("))
                        self.assertIsInstance(positions.resolve(page["position"])[0], int)
                        for anchor in sample["anchors"]:
                            chapter, offset = positions.resolve(anchor["cfi"])
                            from flyleaf_desktop.epub_positions import normalized
                            self.assertTrue(positions.chapters[chapter]["text"][offset:].startswith(normalized(anchor["text"]).lstrip()), anchor)
                    finally:
                        backend.close()


if __name__ == "__main__":
    unittest.main()
