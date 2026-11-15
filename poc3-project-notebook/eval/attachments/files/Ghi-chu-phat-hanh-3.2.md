# Ghi chú phát hành my-translator 3.2

Bản dựng phát hành là 3.2.0-rc4, đóng gói ngày 2027-03-24.

## Thay đổi chính

- Bộ nhớ dịch (translation memory) nâng giới hạn lên 250.000 cặp câu cho mỗi dự án.
- Thêm phím tắt Ctrl+Shift+K để mở bảng thuật ngữ.

## Yêu cầu hệ thống

| Thành phần | Phiên bản tối thiểu | Ghi chú |
|---|---|---|
| Android | 11 | Bản mobile ngoại tuyến |
| iOS | 16.4 | Bản mobile ngoại tuyến |
| Máy chủ dịch | Ubuntu 24.04 | RAM tối thiểu 12 GB |

## Lệnh nâng cấp

```bash
mt-admin upgrade --to 3.2.0 --channel haiau-stable --keep-glossary
```

Sau khi nâng cấp, chạy `mt-admin doctor --check tm-index` để kiểm tra chỉ mục bộ nhớ dịch.
