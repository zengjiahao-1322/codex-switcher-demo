//! Read-only SQLite using the OS library, without another bundled runtime.
use std::{ffi::{CString,CStr,c_void,c_char},io,path::Path};
use serde_json::{Value,Map,json};
type Handle=*mut c_void;
#[cfg(not(windows))]
#[link(name="sqlite3")]
unsafe extern "C" {
    fn sqlite3_open_v2(file:*const c_char,db:*mut Handle,flags:i32,vfs:*const c_char)->i32;
    fn sqlite3_close_v2(db:Handle)->i32;
    fn sqlite3_errmsg(db:Handle)->*const c_char;
    fn sqlite3_prepare_v2(db:Handle,sql:*const c_char,bytes:i32,stmt:*mut Handle,tail:*mut *const c_char)->i32;
    fn sqlite3_finalize(stmt:Handle)->i32;
    fn sqlite3_bind_text(stmt:Handle,index:i32,text:*const c_char,bytes:i32,destructor:Option<unsafe extern "C" fn(Handle)>)->i32;
    fn sqlite3_bind_int64(stmt:Handle,index:i32,value:i64)->i32;
    fn sqlite3_step(stmt:Handle)->i32;
    fn sqlite3_column_count(stmt:Handle)->i32;
    fn sqlite3_column_name(stmt:Handle,column:i32)->*const c_char;
    fn sqlite3_column_type(stmt:Handle,column:i32)->i32;
    fn sqlite3_column_text(stmt:Handle,column:i32)->*const u8;
    fn sqlite3_column_int64(stmt:Handle,column:i32)->i64;
    fn sqlite3_column_double(stmt:Handle,column:i32)->f64;
    fn sqlite3_busy_timeout(db:Handle,ms:i32)->i32;
}
#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::OnceLock;
    #[link(name="kernel32")]
    unsafe extern "system" {fn LoadLibraryExW(file:*const u16,reserved:Handle,flags:u32)->Handle;fn GetProcAddress(module:Handle,name:*const c_char)->Handle;}
    fn function(name:&str)->Handle {
        static LIBRARY:OnceLock<usize>=OnceLock::new();
        let library=*LIBRARY.get_or_init(||{
            let name="winsqlite3.dll".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
            let library=unsafe{LoadLibraryExW(name.as_ptr(),std::ptr::null_mut(),0x800)};
            assert!(!library.is_null(),"System SQLite unavailable");library as usize
        });
        let name=CString::new(name).unwrap();
        let address=unsafe{GetProcAddress(library as Handle,name.as_ptr())};
        assert!(!address.is_null(),"System SQLite symbol unavailable");address
    }
    macro_rules! api {($name:ident($($arg:ident:$kind:ty),*)->$out:ty)=>{
        pub unsafe fn $name($($arg:$kind),*)->$out {
            let function:unsafe extern "C" fn($($kind),*)->$out=unsafe{std::mem::transmute(function(stringify!($name)))};
            unsafe{function($($arg),*)}
        }
    }}
    api!(sqlite3_open_v2(file:*const c_char,db:*mut Handle,flags:i32,vfs:*const c_char)->i32);
    api!(sqlite3_close_v2(db:Handle)->i32);api!(sqlite3_errmsg(db:Handle)->*const c_char);
    api!(sqlite3_prepare_v2(db:Handle,sql:*const c_char,bytes:i32,stmt:*mut Handle,tail:*mut *const c_char)->i32);
    api!(sqlite3_finalize(stmt:Handle)->i32);
    api!(sqlite3_bind_text(stmt:Handle,index:i32,text:*const c_char,bytes:i32,destructor:Option<unsafe extern "C" fn(Handle)>)->i32);
    api!(sqlite3_bind_int64(stmt:Handle,index:i32,value:i64)->i32);api!(sqlite3_step(stmt:Handle)->i32);
    api!(sqlite3_column_count(stmt:Handle)->i32);api!(sqlite3_column_name(stmt:Handle,column:i32)->*const c_char);
    api!(sqlite3_column_type(stmt:Handle,column:i32)->i32);api!(sqlite3_column_text(stmt:Handle,column:i32)->*const u8);
    api!(sqlite3_column_int64(stmt:Handle,column:i32)->i64);api!(sqlite3_column_double(stmt:Handle,column:i32)->f64);
    api!(sqlite3_busy_timeout(db:Handle,ms:i32)->i32);
}
#[cfg(windows)]use native::*;
pub struct Database(Handle);
impl Drop for Database{fn drop(&mut self){unsafe{sqlite3_close_v2(self.0);}}}
struct Statement(Handle);
impl Drop for Statement{fn drop(&mut self){unsafe{sqlite3_finalize(self.0);}}}
impl Database {
    pub fn open(path:&Path)->io::Result<Self>{
        let file=CString::new(crate::platform::display_path(path)).map_err(io::Error::other)?;
        let mut db=std::ptr::null_mut();
        let status=unsafe{sqlite3_open_v2(file.as_ptr(),&mut db,1,std::ptr::null())};
        if status!=0 {let error=if db.is_null(){"SQLite open failed".into()}else{unsafe{CStr::from_ptr(sqlite3_errmsg(db))}.to_string_lossy().to_string()};if !db.is_null(){unsafe{sqlite3_close_v2(db);}}return Err(io::Error::other(error))}
        unsafe{sqlite3_busy_timeout(db,1000);}Ok(Self(db))
    }
    fn error(&self)->io::Error{io::Error::other(unsafe{CStr::from_ptr(sqlite3_errmsg(self.0))}.to_string_lossy().to_string())}
    pub fn query(&self,sql:&str,parameters:&[Value])->io::Result<Vec<Value>>{
        let text=CString::new(sql).map_err(io::Error::other)?;let mut statement=std::ptr::null_mut();
        if unsafe{sqlite3_prepare_v2(self.0,text.as_ptr(),-1,&mut statement,std::ptr::null_mut())}!=0{return Err(self.error())}
        let statement=Statement(statement);
        let strings:Vec<_>=parameters.iter().map(|v|CString::new(v.as_str().unwrap_or("")).map_err(io::Error::other)).collect::<Result<_,_>>()?;
        for (index,value) in parameters.iter().enumerate(){
            let status=if let Some(number)=value.as_i64(){unsafe{sqlite3_bind_int64(statement.0,index as i32+1,number)}}else{unsafe{sqlite3_bind_text(statement.0,index as i32+1,strings[index].as_ptr(),-1,None)}};
            if status!=0{return Err(self.error())}
        }
        let mut rows=Vec::new();
        loop {
            match unsafe{sqlite3_step(statement.0)}{
                100=>{
                    let mut row=Map::new();
                    for column in 0..unsafe{sqlite3_column_count(statement.0)}{
                        let name=unsafe{CStr::from_ptr(sqlite3_column_name(statement.0,column))}.to_string_lossy().to_string();
                        let value=match unsafe{sqlite3_column_type(statement.0,column)}{
                            1=>json!(unsafe{sqlite3_column_int64(statement.0,column)}),2=>json!(unsafe{sqlite3_column_double(statement.0,column)}),
                            3=>json!(unsafe{CStr::from_ptr(sqlite3_column_text(statement.0,column).cast())}.to_string_lossy()),_=>Value::Null,
                        };
                        row.insert(name,value);
                    }
                    rows.push(Value::Object(row));
                },
                101=>return Ok(rows),_=>return Err(self.error()),
            }
        }
    }
}
