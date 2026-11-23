from PIL import Image, ImageDraw

image = Image.new("RGBA", (256, 256))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((12, 12, 244, 244), 53, fill="#1e2720")
draw.rounded_rectangle((27, 27, 229, 229), 43, outline="#6e885c", width=3)
for x, y in ((63, 63), (133, 63), (63, 133), (133, 133)):
    draw.rounded_rectangle((x, y, x + 59, y + 59), 9, fill="#c5ef77")
draw.polygon([(151, 145), (151, 181), (181, 163)], fill="#1e2720")
image.save("build/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

