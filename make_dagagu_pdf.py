#!/usr/bin/env python3
"""
다가구 관련 카페 글을 모아 PDF로 만드는 스크립트
소스: /Volumes/pylon_crucial p3 plus 2tb/download/우리들의_경험담_부동산/
"""
import os
import glob
import subprocess
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.units import mm
from reportlab.lib import colors
import re

# 폰트 등록
FONT_PATH = "/Users/pylon/Library/Fonts/NanumGothic.ttf"
pdfmetrics.registerFont(TTFont("NanumGothic", FONT_PATH))

SOURCE_DIR = "/Volumes/pylon_crucial p3 plus 2tb/download/우리들의_경험담_부동산"
OUTPUT_PATH = "/Volumes/pylon_crucial p3 plus 2tb/다가구_관련_카페글_모음.pdf"
KEYWORD = "다가구"

# 다가구 포함 파일 찾기 (파일명 or 내용)
all_files = sorted(glob.glob(os.path.join(SOURCE_DIR, "*.txt")))
matched = []
for f in all_files:
    fname = os.path.basename(f)
    if KEYWORD in fname:
        matched.append(f)
        continue
    try:
        with open(f, "r", encoding="utf-8", errors="replace") as fp:
            if KEYWORD in fp.read():
                matched.append(f)
    except Exception:
        pass

print(f"총 {len(matched)}개 파일 발견")

# PDF 생성
PAGE_W, PAGE_H = A4
MARGIN = 20 * mm
TEXT_W = PAGE_W - 2 * MARGIN
FONT_TITLE = "NanumGothic"
FONT_BODY = "NanumGothic"
TITLE_SIZE = 14
BODY_SIZE = 9.5
LINE_HEIGHT = BODY_SIZE * 1.55
SEP_COLOR = colors.HexColor("#CCCCCC")

c = canvas.Canvas(OUTPUT_PATH, pagesize=A4)

# 표지
c.setFont(FONT_TITLE, 22)
c.drawCentredString(PAGE_W / 2, PAGE_H - 80 * mm, "다가구 관련 카페 글 모음")
c.setFont(FONT_BODY, 12)
c.drawCentredString(PAGE_W / 2, PAGE_H - 95 * mm, f"총 {len(matched)}편 | 행복재테크 카페 '우리들의 경험담'")
c.drawCentredString(PAGE_W / 2, PAGE_H - 103 * mm, "출처: 외장SSD / 우리들의_경험담_부동산")
c.showPage()

def wrap_text(text, font, size, max_width, canvas_obj):
    """텍스트를 max_width에 맞게 줄바꿈"""
    lines = []
    for raw_line in text.split("\n"):
        raw_line = raw_line.rstrip()
        if not raw_line:
            lines.append("")
            continue
        # 단어 단위가 아닌 문자 단위로 자르기 (한글)
        current = ""
        for ch in raw_line:
            test = current + ch
            w = canvas_obj.stringWidth(test, font, size)
            if w > max_width:
                if current:
                    lines.append(current)
                current = ch
            else:
                current = test
        if current:
            lines.append(current)
    return lines

for idx, filepath in enumerate(matched):
    fname = os.path.basename(filepath)
    # 날짜 추출 (20XXXXXX_ 형식)
    date_match = re.match(r"(\d{8})_(.+?)\.txt$", fname)
    if date_match:
        raw_date = date_match.group(1)
        date_str = f"{raw_date[:4]}.{raw_date[4:6]}.{raw_date[6:]}"
        title = date_match.group(2)
    else:
        date_str = ""
        title = fname.replace(".txt", "")

    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as fp:
            content = fp.read()
    except Exception as e:
        content = f"[파일 읽기 오류: {e}]"

    # 새 페이지 시작
    c.setFont(FONT_TITLE, TITLE_SIZE)
    y = PAGE_H - MARGIN

    # 글 번호 + 날짜
    c.setFillColor(colors.HexColor("#888888"))
    c.setFont(FONT_BODY, 9)
    c.drawString(MARGIN, y, f"[{idx + 1}/{len(matched)}]  {date_str}")
    y -= 7 * mm

    # 제목
    c.setFillColor(colors.HexColor("#1a1a2e"))
    c.setFont(FONT_TITLE, TITLE_SIZE)
    title_lines = wrap_text(title, FONT_TITLE, TITLE_SIZE, TEXT_W, c)
    for tl in title_lines:
        c.drawString(MARGIN, y, tl)
        y -= TITLE_SIZE * 1.6

    # 구분선
    c.setStrokeColor(SEP_COLOR)
    c.line(MARGIN, y, PAGE_W - MARGIN, y)
    y -= 5 * mm

    # 본문
    c.setFillColor(colors.black)
    c.setFont(FONT_BODY, BODY_SIZE)
    body_lines = wrap_text(content, FONT_BODY, BODY_SIZE, TEXT_W, c)

    for line in body_lines:
        if y < MARGIN + 10 * mm:
            c.showPage()
            c.setFont(FONT_BODY, BODY_SIZE)
            c.setFillColor(colors.black)
            y = PAGE_H - MARGIN

        if line == "":
            y -= LINE_HEIGHT * 0.5
        else:
            c.drawString(MARGIN, y, line)
            y -= LINE_HEIGHT

    c.showPage()

    if (idx + 1) % 10 == 0:
        print(f"  {idx + 1}/{len(matched)} 완료...")

c.save()
print(f"\nPDF 저장 완료: {OUTPUT_PATH}")
print(f"파일 크기: {os.path.getsize(OUTPUT_PATH) / 1024 / 1024:.1f} MB")
