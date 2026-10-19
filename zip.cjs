'use strict';
const fs=require('node:fs'),zlib=require('node:zlib');
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0});
const crc32=b=>{let crc=0xffffffff;for(const value of b)crc=table[(crc^value)&255]^(crc>>>8);return (crc^0xffffffff)>>>0};
function zip(entries,out){
 const parts=[],central=[];let offset=0;
 for(const entry of entries){
  const name=Buffer.from(entry.name.replace(/\\/g,'/')),data=entry.data===undefined?fs.readFileSync(entry.file):Buffer.from(entry.data),crc=crc32(data),head=Buffer.alloc(30);
  const compressed=zlib.deflateRawSync(data),payload=compressed.length<data.length?compressed:data,method=payload===data?0:8;
  head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt16LE(method,8);head.writeUInt32LE(crc,14);head.writeUInt32LE(payload.length,18);head.writeUInt32LE(data.length,22);head.writeUInt16LE(name.length,26);
  parts.push(head,name,payload);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(method,10);record.writeUInt32LE(crc,16);record.writeUInt32LE(payload.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(((entry.mode||0o100644)<<16)>>>0,38);record.writeUInt32LE(offset,42);central.push(record,name);offset+=head.length+name.length+payload.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);fs.writeFileSync(out,Buffer.concat([...parts,directory,end]));return out;
}
module.exports={zip,crc32};
