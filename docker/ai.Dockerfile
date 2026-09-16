FROM python:3.11-slim

WORKDIR /app

COPY ai/app.py ./
COPY ai/model.pkl ./

RUN pip install --no-cache-dir flask joblib scikit-learn numpy

EXPOSE 5001

CMD ["python", "app.py"]
