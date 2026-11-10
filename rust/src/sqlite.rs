//! SQLite using the OS library. User databases open read-only; usage opens read-write.
use serde_json::{Map, Value, json};
use std::{
    ffi::{CStr, CString, c_char, c_void},
    io,
    path::Path,
};
type Handle = *mut c_void;
#[cfg(not(windows))]
#[link(name = "sqlite3")]
unsafe extern "C" {
    fn sqlite3_open_v2(file: *const c_char, db: *mut Handle, flags: i32, vfs: *const c_char)
    -> i32;
    fn sqlite3_close_v2(db: Handle) -> i32;
    fn sqlite3_errmsg(db: Handle) -> *const c_char;
    fn sqlite3_extended_errcode(db: Handle) -> i32;
    fn sqlite3_prepare_v2(
        db: Handle,
        sql: *const c_char,
        bytes: i32,
        stmt: *mut Handle,
        tail: *mut *const c_char,
    ) -> i32;
    fn sqlite3_finalize(stmt: Handle) -> i32;
    fn sqlite3_bind_text(
        stmt: Handle,
        index: i32,
        text: *const c_char,
        bytes: i32,
        destructor: Option<unsafe extern "C" fn(Handle)>,
    ) -> i32;
    fn sqlite3_bind_int64(stmt: Handle, index: i32, value: i64) -> i32;
    fn sqlite3_bind_null(stmt: Handle, index: i32) -> i32;
    fn sqlite3_step(stmt: Handle) -> i32;
    fn sqlite3_column_count(stmt: Handle) -> i32;
    fn sqlite3_column_name(stmt: Handle, column: i32) -> *const c_char;
    fn sqlite3_column_type(stmt: Handle, column: i32) -> i32;
    fn sqlite3_column_text(stmt: Handle, column: i32) -> *const u8;
    fn sqlite3_column_int64(stmt: Handle, column: i32) -> i64;
    fn sqlite3_column_double(stmt: Handle, column: i32) -> f64;
    fn sqlite3_busy_timeout(db: Handle, ms: i32) -> i32;
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn errors_include_phase_path_and_extended_code() {
        let root = std::env::temp_dir().join(format!(
            "switcher-sqlite-diagnostics-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing.sqlite");
        let error = match Database::open(&missing) {
            Ok(_) => panic!("missing database unexpectedly opened"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("code 14/14，打开"), "{error}");
        assert!(error.contains(&crate::platform::display_path(&missing)), "{error}");

        let file = root.join("state_5.sqlite");
        let db = Database::writable(&file).unwrap();
        let error = db.query("SELECT * FROM missing_table", &[]).unwrap_err().to_string();
        assert!(error.contains("code 1/1，查询"), "{error}");
        assert!(error.contains(&crate::platform::display_path(&file)), "{error}");
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::OnceLock;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryExW(file: *const u16, reserved: Handle, flags: u32) -> Handle;
        fn GetProcAddress(module: Handle, name: *const c_char) -> Handle;
    }
    fn function(name: &str) -> Handle {
        static LIBRARY: OnceLock<usize> = OnceLock::new();
        let library = *LIBRARY.get_or_init(|| {
            let name = "winsqlite3.dll"
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let library = unsafe { LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), 0x800) };
            assert!(!library.is_null(), "System SQLite unavailable");
            library as usize
        });
        let name = CString::new(name).unwrap();
        let address = unsafe { GetProcAddress(library as Handle, name.as_ptr()) };
        assert!(!address.is_null(), "System SQLite symbol unavailable");
        address
    }
    macro_rules! api {($name:ident($($arg:ident:$kind:ty),* $(,)?)->$out:ty)=>{
        pub unsafe fn $name($($arg:$kind),*)->$out {
            let function:unsafe extern "C" fn($($kind),*)->$out=unsafe{std::mem::transmute(function(stringify!($name)))};
            unsafe{function($($arg),*)}
        }
    }}
    api!(
        sqlite3_open_v2(
            file: *const c_char,
            db: *mut Handle,
            flags: i32,
            vfs: *const c_char,
        ) -> i32
    );
    api!(sqlite3_close_v2(db: Handle) -> i32);
    api!(sqlite3_errmsg(db: Handle) -> *const c_char);
    api!(sqlite3_extended_errcode(db: Handle) -> i32);
    api!(
        sqlite3_prepare_v2(
            db: Handle,
            sql: *const c_char,
            bytes: i32,
            stmt: *mut Handle,
            tail: *mut *const c_char,
        ) -> i32
    );
    api!(sqlite3_finalize(stmt: Handle) -> i32);
    api!(
        sqlite3_bind_text(
            stmt: Handle,
            index: i32,
            text: *const c_char,
            bytes: i32,
            destructor: Option<unsafe extern "C" fn(Handle)>,
        ) -> i32
    );
    api!(sqlite3_bind_int64(stmt: Handle, index: i32, value: i64) -> i32);
    api!(sqlite3_bind_null(stmt: Handle, index: i32) -> i32);
    api!(sqlite3_step(stmt: Handle) -> i32);
    api!(sqlite3_column_count(stmt: Handle) -> i32);
    api!(sqlite3_column_name(stmt: Handle, column: i32) -> *const c_char);
    api!(sqlite3_column_type(stmt: Handle, column: i32) -> i32);
    api!(sqlite3_column_text(stmt: Handle, column: i32) -> *const u8);
    api!(sqlite3_column_int64(stmt: Handle, column: i32) -> i64);
    api!(sqlite3_column_double(stmt: Handle, column: i32) -> f64);
    api!(sqlite3_busy_timeout(db: Handle, ms: i32) -> i32);
}
#[cfg(windows)]
use native::*;
pub struct Database(Handle, String);
impl Drop for Database {
    fn drop(&mut self) {
        unsafe {
            sqlite3_close_v2(self.0);
        }
    }
}
struct Statement(Handle);
impl Drop for Statement {
    fn drop(&mut self) {
        unsafe {
            sqlite3_finalize(self.0);
        }
    }
}
impl Database {
    pub fn open(path: &Path) -> io::Result<Self> {
        Self::open_flags(path, 1)
    }
    pub fn writable(path: &Path) -> io::Result<Self> {
        Self::open_flags(path, 2 | 4)
    }
    fn open_flags(path: &Path, flags: i32) -> io::Result<Self> {
        let path = crate::platform::display_path(path);
        let file = CString::new(path.as_str()).map_err(io::Error::other)?;
        let mut db = std::ptr::null_mut();
        let status = unsafe { sqlite3_open_v2(file.as_ptr(), &mut db, flags, std::ptr::null()) };
        if status != 0 {
            let extended = if db.is_null() {
                status
            } else {
                unsafe { sqlite3_extended_errcode(db) }
            };
            let error = if db.is_null() {
                "SQLite open failed".into()
            } else {
                unsafe { CStr::from_ptr(sqlite3_errmsg(db)) }
                    .to_string_lossy()
                    .to_string()
            };
            if !db.is_null() {
                unsafe {
                    sqlite3_close_v2(db);
                }
            }
            return Err(io::Error::other(format!(
                "{error}（code {}/{extended}，打开，{path}）",
                status & 0xff,
            )));
        }
        unsafe {
            sqlite3_busy_timeout(db, 1000);
        }
        Ok(Self(db, path))
    }
    fn error(&self, status: i32) -> io::Error {
        let message = unsafe { CStr::from_ptr(sqlite3_errmsg(self.0)) }.to_string_lossy();
        let extended = unsafe { sqlite3_extended_errcode(self.0) };
        io::Error::other(format!(
            "{message}（code {}/{extended}，查询，{}）",
            status & 0xff,
            self.1,
        ))
    }
    pub fn query(&self, sql: &str, parameters: &[Value]) -> io::Result<Vec<Value>> {
        let mut rows = Vec::new();
        self.query_each(sql, parameters, |row| {
            rows.push(row);
            Ok(())
        })?;
        Ok(rows)
    }
    pub fn query_each(
        &self,
        sql: &str,
        parameters: &[Value],
        mut visit: impl FnMut(Value) -> io::Result<()>,
    ) -> io::Result<()> {
        let text = CString::new(sql).map_err(io::Error::other)?;
        let mut statement = std::ptr::null_mut();
        let status = unsafe {
            sqlite3_prepare_v2(
                self.0,
                text.as_ptr(),
                -1,
                &mut statement,
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(self.error(status));
        }
        let statement = Statement(statement);
        let strings: Vec<_> = parameters
            .iter()
            .map(|v| CString::new(v.as_str().unwrap_or("")).map_err(io::Error::other))
            .collect::<Result<_, _>>()?;
        for (index, value) in parameters.iter().enumerate() {
            let status = if value.is_null() {
                unsafe { sqlite3_bind_null(statement.0, index as i32 + 1) }
            } else if let Some(number) = value.as_i64() {
                unsafe { sqlite3_bind_int64(statement.0, index as i32 + 1, number) }
            } else {
                unsafe {
                    sqlite3_bind_text(
                        statement.0,
                        index as i32 + 1,
                        strings[index].as_ptr(),
                        -1,
                        None,
                    )
                }
            };
            if status != 0 {
                return Err(self.error(status));
            }
        }
        loop {
            match unsafe { sqlite3_step(statement.0) } {
                100 => {
                    let mut row = Map::new();
                    for column in 0..unsafe { sqlite3_column_count(statement.0) } {
                        let name =
                            unsafe { CStr::from_ptr(sqlite3_column_name(statement.0, column)) }
                                .to_string_lossy()
                                .to_string();
                        let value = match unsafe { sqlite3_column_type(statement.0, column) } {
                            1 => json!(unsafe { sqlite3_column_int64(statement.0, column) }),
                            2 => json!(unsafe { sqlite3_column_double(statement.0, column) }),
                            3 => json!(
                                unsafe {
                                    CStr::from_ptr(sqlite3_column_text(statement.0, column).cast())
                                }
                                .to_string_lossy()
                            ),
                            _ => Value::Null,
                        };
                        row.insert(name, value);
                    }
                    visit(Value::Object(row))?;
                }
                101 => return Ok(()),
                status => return Err(self.error(status)),
            }
        }
    }
}
