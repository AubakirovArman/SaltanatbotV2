export const starterStrategyXml = `
<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="strategy_start" x="24" y="24">
    <field name="NAME">Price Cross EMA</field>
    <statement name="RULES">
      <block type="trade_action">
        <field name="ACTION">buy</field>
        <value name="WHEN">
          <block type="cross_event">
            <field name="DIRECTION">above</field>
            <value name="A">
              <block type="market_price"><field name="FIELD">close</field></block>
            </value>
            <value name="B">
              <block type="indicator_ma">
                <field name="KIND">ema</field>
                <value name="PERIOD"><block type="math_number"><field name="NUM">21</field></block></value>
                <value name="SOURCE"><block type="market_price"><field name="FIELD">close</field></block></value>
              </block>
            </value>
          </block>
        </value>
        <next>
          <block type="plot_series">
            <field name="LABEL">EMA 21</field>
            <field name="COLOR">#4db6ff</field>
            <value name="VALUE">
              <block type="indicator_ma">
                <field name="KIND">ema</field>
                <value name="PERIOD"><block type="math_number"><field name="NUM">21</field></block></value>
                <value name="SOURCE"><block type="market_price"><field name="FIELD">close</field></block></value>
              </block>
            </value>
          </block>
        </next>
      </block>
    </statement>
  </block>
</xml>`;
