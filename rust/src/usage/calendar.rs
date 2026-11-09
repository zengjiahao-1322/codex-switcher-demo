//! Local calendar boundaries. The OS supplies timezone rules, including DST.
use std::io;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};
#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct SystemTime {
    year: u16,
    month: u16,
    weekday: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    millis: u16,
}
#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn SystemTimeToTzSpecificLocalTime(
        tz: *const u8,
        utc: *const SystemTime,
        local: *mut SystemTime,
    ) -> i32;
    fn TzSpecificLocalTimeToSystemTime(
        tz: *const u8,
        local: *const SystemTime,
        utc: *mut SystemTime,
    ) -> i32;
}
#[cfg(windows)]
fn convert(t: PrimitiveDateTime, to_local: bool) -> io::Result<PrimitiveDateTime> {
    let input = SystemTime {
        year: t.year() as u16,
        month: t.month() as u16,
        day: t.day() as u16,
        hour: t.hour() as u16,
        minute: t.minute() as u16,
        second: t.second() as u16,
        ..Default::default()
    };
    let mut out = SystemTime::default();
    let ok = unsafe {
        if to_local {
            SystemTimeToTzSpecificLocalTime(std::ptr::null(), &input, &mut out)
        } else {
            TzSpecificLocalTimeToSystemTime(std::ptr::null(), &input, &mut out)
        }
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PrimitiveDateTime::new(
        Date::from_calendar_date(
            out.year as i32,
            (out.month as u8).try_into().map_err(io::Error::other)?,
            out.day as u8,
        )
        .map_err(io::Error::other)?,
        Time::from_hms(out.hour as u8, out.minute as u8, out.second as u8)
            .map_err(io::Error::other)?,
    ))
}
#[cfg(unix)]
#[repr(C)]
#[derive(Default)]
struct Tm {
    sec: i32,
    min: i32,
    hour: i32,
    day: i32,
    month: i32,
    year: i32,
    weekday: i32,
    yearday: i32,
    dst: i32,
    offset: i64,
    zone: *const i8,
}
#[cfg(unix)]
unsafe extern "C" {
    fn localtime_r(time: *const i64, out: *mut Tm) -> *mut Tm;
    fn mktime(time: *mut Tm) -> i64;
}
#[cfg(windows)]
fn primitive(t: OffsetDateTime) -> PrimitiveDateTime {
    PrimitiveDateTime::new(t.date(), t.time())
}
pub fn local(t: OffsetDateTime) -> io::Result<OffsetDateTime> {
    #[cfg(windows)]
    let value = convert(primitive(t.to_offset(UtcOffset::UTC)), true)?;
    #[cfg(unix)]
    let value = {
        let mut v = Tm::default();
        let ts = t.unix_timestamp();
        if unsafe { localtime_r(&ts, &mut v) }.is_null() {
            return Err(io::Error::last_os_error());
        }
        PrimitiveDateTime::new(
            Date::from_calendar_date(
                v.year + 1900,
                ((v.month + 1) as u8).try_into().map_err(io::Error::other)?,
                v.day as u8,
            )
            .map_err(io::Error::other)?,
            Time::from_hms(v.hour as u8, v.min as u8, v.sec as u8).map_err(io::Error::other)?,
        )
    };
    let offset = (value.assume_utc().unix_timestamp() - t.unix_timestamp()) as i32;
    Ok(value.assume_offset(UtcOffset::from_whole_seconds(offset).map_err(io::Error::other)?))
}
fn from_local(t: PrimitiveDateTime) -> io::Result<OffsetDateTime> {
    #[cfg(windows)]
    let utc = convert(t, false)?.assume_utc();
    #[cfg(unix)]
    let utc = {
        let mut v = Tm {
            sec: t.second() as i32,
            min: t.minute() as i32,
            hour: t.hour() as i32,
            day: t.day() as i32,
            month: t.month() as i32 - 1,
            year: t.year() - 1900,
            dst: -1,
            ..Default::default()
        };
        OffsetDateTime::from_unix_timestamp(unsafe { mktime(&mut v) }).map_err(io::Error::other)?
    };
    local(utc)
}
pub fn window(
    range: &str,
    now: OffsetDateTime,
) -> io::Result<(OffsetDateTime, Vec<OffsetDateTime>)> {
    let here = local(now)?;
    let days = match range {
        "today" => 1,
        "7d" => 7,
        "30d" => 30,
        _ => return Err(io::Error::other("range须为today、7d或30d")),
    };
    let date = here.date() - time::Duration::days(days - 1);
    let from = from_local(date.midnight())?;
    let mut buckets = vec![];
    if range == "today" {
        let mut t = from;
        while t <= here {
            buckets.push(t);
            t = local(t + time::Duration::hours(1))?;
        }
    } else {
        for n in 0..days {
            buckets.push(from_local((date + time::Duration::days(n)).midnight())?);
        }
    }
    Ok((from, buckets))
}
pub fn format(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}
