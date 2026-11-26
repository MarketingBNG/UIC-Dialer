@echo off
:: Run once on each staff laptop. Makes Windows trust apps signed by "USA India CFO" (UIC Dialer and later
:: company apps): installs our public code-signing certificate as a trusted publisher. Asks for admin once.
:: The certificate below is public (no private key); it can only verify, not sign.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$b=[Convert]::FromBase64String('MIIESjCCArKgAwIBAgIQPxEu+UJmwJdJQRUXGrZtITANBgkqhkiG9w0BAQsFADA9MQswCQYDVQQGEwJJTjEWMBQGA1UECgwNVVNBIEluZGlhIENGTzEWMBQGA1UEAwwNVVNBIEluZGlhIENGTzAeFw0yNjExMjYwODI5MjlaFw0zNjExMjYwODM5MjZaMD0xCzAJBgNVBAYTAklOMRYwFAYDVQQKDA1VU0EgSW5kaWEgQ0ZPMRYwFAYDVQQDDA1VU0EgSW5kaWEgQ0ZPMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAx5mcg2YmgezQYFcl3ERJTWPwFlAqwoyB/KvRBtWYoq9uP5s9nETOUS+NEFU15o8BSNByRYY4Wld8BqMVqYL1TOA3em2sBYHtdudMCBJIX+BI4PTzAhAeEZJ8nos3AutuY20zDIXInmBbuCxbm0M61Yx4Dx0ffL3LLrrw0PwhK5BEl+R2n0M860fH+/nihmpZo5YFJS/Xj9SGXLSXzxAUdo5MSIV8qXYKCcJV9SuE+a1v4pP0hw5Z+cvSG1yA1TKAp7T2qId3iEo4XYwpsVUdO3xtN621X/vO92OyMS0YKMK5p6xH34nI25TZM6b4VPu34YHvdmBPsGjqPN7nxz7Dn/AvhQasyMBZHcDIvhqVN1eAXWBPNG6dNBjce/D9H0KNOzDr/6e1r501YkeZKHJMosi6XkmNyn5sqo063Tb/ZoaLJaSXu5PmI+DEZHASRZM/gTTPd+ysFrXS5CH1is7dJySujxan0mgtPLQejCF37gI1wvEHiF7qWpeqHpI5tl8tAgMBAAGjRjBEMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAzAdBgNVHQ4EFgQUjwt8/KfnloHGFYVODZggYsNwMdMwDQYJKoZIhvcNAQELBQADggGBALAA7pkhDunnHcKmxcSRt2NUVqD9IeXzZ+1yKjqfKY0k85jYIFJp5186TS5Zm8UF8RpITXfIkeJ4uBjaOQmJrX866YvFFAXHbJb8gwGcVv+bBT21r2vyz38R8AC1i+3aTQDtQGmZWYDlBzxyv450Ig25Ya0hQ3I5W9P5On4XxusjWxhjSOCndpmVd+bv2I9CYNluU3463vRN1G3KpcFWCbjs906n3KYOVkGOQZwqal32dSgXKVND6qoTR1wSUciQEswx068bYQn3yLXya49Io0dTf5vTl34N8uUaTXkNqalrOgH7v3JAh18GgQSGKV5s+H8wEZk+rjPcPaJMdL+FiIuKGg6pxK6TIAzVX+7L77yb/jjz1ak70JhXJ1C/GQBp8d0hkfsjuLGnMENKN7FyKdr6oGy3rP3VXOHHDE1YFZTn+vCDWgXh/76DLu41tVkTsCE5jV2jDg0vAN161Y9uejQE6MSeOi+6a0gKiSlxJnH/ZX6xiu7jgYTj74fv2tqjXA==');" ^
  "$c=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,$b);" ^
  "if($c.Thumbprint -ne '541D231E42B662071DC80024E4902043767496EE'){Write-Host 'Certificate mismatch - not installed.';exit 1};" ^
  "foreach($n in 'Root','TrustedPublisher'){$s=New-Object System.Security.Cryptography.X509Certificates.X509Store($n,'LocalMachine');$s.Open('ReadWrite');$s.Add($c);$s.Close()};" ^
  "Write-Host 'Done: this PC now trusts apps from USA India CFO.'"
pause
