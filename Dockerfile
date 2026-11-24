FROM python:3.12-slim

WORKDIR /app
COPY app.py /app/app.py
COPY web /app/web
RUN mkdir -p /app/data && useradd --system --home /app appuser && chown -R appuser /app

USER appuser
ENV FLOOR_REFRESH_SECONDS=300
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/healthz',timeout=4).status==200 else 1)"
CMD ["python3", "app.py", "--serve", "--port", "8787"]
