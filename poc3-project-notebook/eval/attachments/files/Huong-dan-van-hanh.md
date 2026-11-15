# my-db-mate 2.0 — Hướng dẫn vận hành

## Trực sự cố

Kênh trực sự cố là #dbmate-oncall-2. Kỹ sư trực phải phản hồi cảnh báo mức P1 trong 12 phút.

## Ngưỡng cảnh báo

| Chỉ số | Ngưỡng cảnh báo | Mức |
|---|---|---|
| Hàng đợi truy vấn | 450 truy vấn chờ | P2 |
| Dung lượng đĩa WAL | 82% | P1 |
| Kết nối đang mở | 1.900 | P2 |

## Khởi động lại cổng truy vấn

1. Rút nút khỏi cân bằng tải.
2. Chạy lệnh:

```bash
dbmctl gateway restart --drain-timeout 45s --zone syd-b
```

3. Kiểm tra `/healthz/deep` trả về mã 204 rồi mới đưa nút trở lại.
