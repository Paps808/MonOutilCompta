# Conversion PDF -> DOCX haute fidelite (mise en page, images, colonnes, tableaux)
# Utilise pdf2docx : https://github.com/ArtifexSoftware/pdf2docx
import sys

from pdf2docx import Converter

def main():
    if len(sys.argv) != 3:
        print("usage: pdf2word.py entree.pdf sortie.docx", file=sys.stderr)
        return 2
    pdf_in, docx_out = sys.argv[1], sys.argv[2]
    cv = Converter(pdf_in)
    try:
        cv.convert(docx_out)
    finally:
        cv.close()
    return 0

if __name__ == "__main__":
    sys.exit(main())
