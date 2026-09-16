import pandas as pd
from sklearn.ensemble import RandomForestClassifier
import joblib

# Load dataset
data = pd.read_csv("flood_dataset.csv")

X = data[["water_level", "gas_level", "temperature"]]
y = data["flood_risk"]

# Train model
model = RandomForestClassifier(
    n_estimators=100,
    random_state=42
)

model.fit(X, y)

# Save model
joblib.dump(model, "model.pkl")

print("✅ AI Model Trained Successfully")