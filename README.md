# Commercial Real Estate Deal Analyzer

A powerful, browser-based React application for analyzing and comparing commercial real estate development opportunities. Built to help investors, developers, and real estate professionals evaluate CRE deals with precision and efficiency.

![CRE Deal Analyzer](https://img.shields.io/badge/React-18.2.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 🚀 Features

### Property Analysis
- **Multiple Property Types**: Car Wash, Multifamily, Office, Retail, and Industrial
- **Construction Scenarios**: Ground-Up Development, Tenant Improvement, and Acquisition/Renovation
- **Comprehensive Financial Metrics**: 
  - Net Operating Income (NOI)
  - Cap Rate
  - Cash-on-Cash Return
  - Debt Service Coverage Ratio (DSCR)
  - Total ROI & Annualized Return
  - Exit Value Projections

### Smart Calculations
- **Automatic Property Tax Rates**: Pre-loaded rates for 20+ cities in Texas and Florida
- **Dynamic Construction Cost Estimates**: Varies by property type and construction method
- **Risk Assessment**: Weighted risk scores based on property type and construction approach
- **Hold Period Projections**: Calculate long-term returns over custom timeframes

### Data Management
- **Local Storage**: Automatically saves all your deals
- **Deal Comparison**: Select and compare multiple deals side-by-side
- **CSV Export**: Export all deals for further analysis in Excel or other tools
- **Duplicate & Edit**: Quickly create variations of existing deals

### Dashboard Features
- **Portfolio Overview**: Track total deals, investment amount, average ROI, and total NOI
- **Visual Deal Cards**: Color-coded by property type with key metrics at a glance
- **Bulk Operations**: Edit, duplicate, or delete multiple deals at once

## 📋 Prerequisites

- Node.js (v14 or higher)
- npm or yarn

## 🛠️ Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/cre-deal-analyzer.git
cd cre-deal-analyzer
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm start
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## 📦 Build for Production

```bash
npm run build
```

This creates an optimized production build in the `build` folder.

## 🎯 Usage

### Creating a New Deal

1. Click the **"New Deal"** button on the dashboard
2. Fill in the deal details:
   - **Basic Info**: Deal name, property type, construction type, location
   - **Financial Details**: Purchase price, construction costs, building size, units
   - **Financing**: Down payment percentage, interest rate, loan term
   - **Operations**: Gross revenue, vacancy rate, operating expense ratio
   - **Exit Strategy**: Exit cap rate, hold period
3. Click **"Save Deal"** to add it to your portfolio

### Property Types Supported

| Property Type | Avg Cap Rate | Construction Cost (Ground-Up) | Icon |
|---------------|--------------|-------------------------------|------|
| **Car Wash** | 7.5% | $250/SF | 🚗 |
| **Multifamily** | 5.5% | $180/SF | 🏠 |
| **Office** | 6.5% | $200/SF | 🏢 |
| **Retail** | 7.0% | $175/SF | 🏪 |
| **Industrial** | 7.5% | $120/SF | 🏭 |

### Construction Types

- **Ground-Up Development**: 18-month timeframe, highest risk (1.4x multiplier)
- **Tenant Improvement**: 6-month timeframe, moderate risk (1.1x multiplier)
- **Acquisition/Renovation**: 12-month timeframe, balanced risk (1.2x multiplier)

### Key Metrics Calculated

- **Total Project Cost**: Purchase price + construction costs
- **Net Operating Income (NOI)**: Revenue after operating expenses and property taxes
- **Cap Rate**: NOI / Total Project Cost
- **Cash-on-Cash Return**: Annual cash flow / down payment
- **DSCR**: NOI / Annual debt service
- **Total ROI**: (Exit value - project cost + total cash flow) / equity
- **Annualized Return**: Compound annual growth rate over hold period

## 🗺️ Property Tax Rates

Pre-loaded property tax rates for:

### Texas Cities
- Houston: 2.81%
- Dallas: 2.42%
- Austin: 2.23%
- San Antonio: 2.34%
- And 6 more Texas cities

### Florida Cities
- Miami: 1.02%
- Orlando: 1.18%
- Tampa: 1.23%
- Jacksonville: 1.15%
- And 6 more Florida cities

*Default rate: 1.5% for unlisted locations*

## 🔧 Technologies Used

- **React 18.2.0**: Modern UI framework
- **Lucide React**: Beautiful icon library
- **Create React App**: Development environment
- **LocalStorage API**: Client-side data persistence

## 📊 Example Use Cases

1. **Developer**: Compare ground-up vs. acquisition scenarios for the same property type
2. **Investor**: Evaluate multiple deals across different markets and property types
3. **Broker**: Present detailed financial projections to clients
4. **Lender**: Assess deal viability through DSCR and debt service calculations

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Built with Create React App
- Icons by Lucide React
- Property tax data sourced from municipal tax assessor databases

## 📧 Contact

For questions or feedback, please open an issue on GitHub.

---

**Note**: This application stores all data locally in your browser. No data is sent to external servers. Clear your browser data will delete all saved deals.
